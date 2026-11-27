// Fetching one web page for `fetch_url` (src/web-tools.ts), safely and in bounded size. Brought over from Pi Desktop's
// pi-host.
//
// - http and https only, no credentials in the URL, ports 80/443 or above 1023.
// - Every address a host resolves to is checked before connecting, and the
//   connection uses the checked address (the check runs in the socket's own
//   DNS lookup), so a host can't resolve to a public address for the check and
//   a private one for the connection. Loopback, private, link-local, CGNAT,
//   multicast and reserved ranges are refused, IPv4 and IPv6.
// - Redirects are followed by hand, up to MAX_REDIRECTS, and each hop gets the
//   same checks.
// - The body is capped at MAX_BYTES; HTML is turned into plain text with links.

import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

export const MAX_BYTES = 5 * 1024 * 1024;
export const MAX_REDIRECTS = 5;
export const FETCH_TIMEOUT_MS = 20_000;
const USER_AGENT = "Mozilla/5.0 (compatible; aludra/1.0)";

/** A fetch refused for a reason the model can act on: the URL's form, its address, its size or its type. */
export class FetchRefused extends Error {}

export interface FetchedPage {
	/** The URL that answered, after redirects. */
	url: string;
	status: number;
	contentType: string;
	title?: string;
	text: string;
}

export interface FetchOptions {
	/** Tests only: allow loopback and private addresses. */
	allowPrivate?: boolean;
	timeoutMs?: number;
	signal?: AbortSignal;
}

const blocked = new BlockList();
for (const [net, prefix] of [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["192.88.99.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
] as const)
	blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
	["::", 128],
	["::1", 128],
	["64:ff9b::", 96], // NAT64. IPv4-mapped (::ffff:0:0/96) is left out: BlockList matches every IPv4 address against it, and isPrivateAddress checks mapped addresses as IPv4.
	["100::", 64],
	["2001::", 23],
	["2001:db8::", 32],
	["2002::", 16],
	["fc00::", 7],
	["fe80::", 10],
	["fec0::", 10],
	["ff00::", 8],
] as const)
	blocked.addSubnet(net, prefix, "ipv6");

/** True for addresses fetch_url must never connect to. */
export function isPrivateAddress(address: string): boolean {
	const family = isIP(address);
	if (family === 4) return blocked.check(address, "ipv4");
	if (family === 6) {
		const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
		if (mapped) return blocked.check(mapped[1]!, "ipv4");
		return blocked.check(address, "ipv6");
	}
	return true;
}

/** Checks a URL's form. Throws FetchRefused with a reason the model can act on. */
export function checkUrl(raw: string | URL): URL {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new FetchRefused(`Not a valid URL: ${String(raw)}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new FetchRefused(`Only http and https URLs can be fetched, not ${url.protocol}`);
	if (url.username || url.password) throw new FetchRefused("URLs with a user name or password can't be fetched.");
	if (url.port && Number(url.port) < 1024 && url.port !== "80" && url.port !== "443") {
		throw new FetchRefused(`Port ${url.port} isn't allowed.`);
	}
	const host = url.hostname.replace(/^\[|\]$/g, "");
	if (/^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.home\.arpa)$/i.test(host)) {
		throw new FetchRefused(`${host} is a local name; only public web addresses can be fetched.`);
	}
	return url;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

function guardedLookup(allowPrivate: boolean) {
	return (hostname: string, options: { all?: boolean }, callback: LookupCallback) => {
		dnsLookup(hostname, { all: true }, (err, addresses) => {
			if (err) return callback(err, []);
			const list = addresses as LookupAddress[];
			const bad = list.find((a) => isPrivateAddress(a.address));
			if (!allowPrivate && (bad || list.length === 0)) {
				const e = new FetchRefused(`${hostname} resolves to a private or reserved address (${bad?.address ?? "none"}).`) as NodeJS.ErrnoException;
				return callback(e, []);
			}
			if (options.all) return callback(null, list);
			callback(null, list[0]!.address, list[0]!.family);
		});
	};
}

export async function fetchPage(raw: string | URL, options: FetchOptions = {}): Promise<FetchedPage> {
	const timeout = AbortSignal.timeout(options.timeoutMs ?? FETCH_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
	let url = checkUrl(raw);
	for (let hop = 0; ; hop++) {
		if (!options.allowPrivate) {
			const literal = url.hostname.replace(/^\[|\]$/g, "");
			if (isIP(literal) && isPrivateAddress(literal)) throw new FetchRefused(`${literal} is a private or reserved address.`);
		}
		const res = await get(url, !!options.allowPrivate, signal).catch((err: unknown) => {
			if (err instanceof FetchRefused) throw err;
			if (timeout.aborted) throw new FetchRefused(`${url.host} didn't answer within ${(options.timeoutMs ?? FETCH_TIMEOUT_MS) / 1000} s.`);
			throw err;
		});
		const status = res.statusCode ?? 0;
		if (status >= 300 && status < 400 && res.headers.location) {
			res.resume();
			if (hop >= MAX_REDIRECTS) throw new FetchRefused(`More than ${MAX_REDIRECTS} redirects.`);
			url = checkUrl(new URL(res.headers.location, url));
			continue;
		}
		const contentType = String(res.headers["content-type"] ?? "").toLowerCase();
		const body = await readBody(res, signal).catch((err: unknown) => {
			if (timeout.aborted) throw new FetchRefused(`${url.host} didn't finish sending within ${(options.timeoutMs ?? FETCH_TIMEOUT_MS) / 1000} s.`);
			throw err;
		});
		const kind = textKind(contentType, body);
		if (!kind) throw new FetchRefused(`${url.href} is ${contentType || "binary content"}, which can't be read as text.`);
		const decoded = decode(body, contentType);
		if (kind === "html") {
			const page = htmlToText(decoded, url);
			return { url: url.href, status, contentType, title: page.title, text: page.text };
		}
		return { url: url.href, status, contentType, text: decoded };
	}
}

function get(url: URL, allowPrivate: boolean, signal: AbortSignal): Promise<IncomingMessage> {
	return new Promise((resolve, reject) => {
		const request = url.protocol === "https:" ? httpsRequest : httpRequest;
		const req = request(
			url,
			{
				method: "GET",
				headers: {
					"user-agent": USER_AGENT,
					accept: "text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.5",
					"accept-encoding": "gzip, deflate, br",
					"accept-language": "en-US,en;q=0.8",
				},
				lookup: guardedLookup(allowPrivate) as never,
				signal,
			},
			resolve,
		);
		req.on("error", reject);
		req.end();
	});
}

async function readBody(res: IncomingMessage, signal: AbortSignal): Promise<Buffer> {
	const encoding = String(res.headers["content-encoding"] ?? "").toLowerCase();
	let stream: NodeJS.ReadableStream = res;
	if (encoding === "gzip" || encoding === "x-gzip") stream = res.pipe(createGunzip());
	else if (encoding === "deflate") stream = res.pipe(createInflate());
	else if (encoding === "br") stream = res.pipe(createBrotliDecompress());
	const chunks: Buffer[] = [];
	let size = 0;
	signal.throwIfAborted();
	const onAbort = () => res.destroy(signal.reason as Error);
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		for await (const chunk of stream as AsyncIterable<Buffer>) {
			size += chunk.length;
			if (size > MAX_BYTES) {
				res.destroy();
				// Keep what fits; a long page is cut, not refused.
				chunks.push(chunk.subarray(0, chunk.length - (size - MAX_BYTES)));
				break;
			}
			chunks.push(chunk);
		}
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
	return Buffer.concat(chunks);
}

function textKind(contentType: string, body: Buffer): "html" | "text" | undefined {
	if (/text\/html|application\/xhtml/.test(contentType)) return "html";
	if (/^text\/|application\/(json|xml|[a-z.+-]*\+(json|xml)|javascript|x-ndjson)/.test(contentType)) return "text";
	if (!contentType) {
		const head = body.subarray(0, 512).toString("utf8").trimStart().toLowerCase();
		if (head.startsWith("<!doctype html") || head.startsWith("<html")) return "html";
		if (!body.subarray(0, 1024).includes(0)) return "text";
	}
	return undefined;
}

function decode(body: Buffer, contentType: string): string {
	const charset = /charset=["']?([\w-]+)/.exec(contentType)?.[1] ?? sniffCharset(body) ?? "utf-8";
	try {
		return new TextDecoder(charset).decode(body);
	} catch {
		return new TextDecoder("utf-8").decode(body);
	}
}

function sniffCharset(body: Buffer): string | undefined {
	const head = body.subarray(0, 2048).toString("latin1");
	return /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
}

// ---- HTML to text ----

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©", reg: "®", trade: "™", middot: "·", bull: "•", laquo: "«", raquo: "»", times: "×" };

export function decodeEntities(text: string): string {
	return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
		if (code[0] === "#") {
			const n = code[1] === "x" || code[1] === "X" ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1));
			return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
		}
		return ENTITIES[code.toLowerCase()] ?? m;
	});
}

/** A readable plain-text version of an HTML page: headings, paragraphs, list items, and links as [text](url). */
export function htmlToText(html: string, base: URL): { title?: string; text: string } {
	const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
	let body = html
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<(script|style|noscript|svg|template|iframe|canvas|head|form|select)\b[\s\S]*?<\/\1\s*>/gi, "");
	// Prefer the main content when the page marks it.
	const main = /<(main|article)\b[^>]*>([\s\S]*?)<\/\1\s*>/i.exec(body)?.[2];
	if (main && main.length > 500) body = main;
	else body = body.replace(/<(nav|footer|aside)\b[\s\S]*?<\/\1\s*>/gi, "");
	body = body
		.replace(/<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi, (_m, a, b, c, inner: string) => {
			const text = inner.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
			const href = decodeEntities(a ?? b ?? c ?? "");
			let abs: string | undefined;
			try {
				const u = new URL(href, base);
				if (u.protocol === "http:" || u.protocol === "https:") abs = u.href;
			} catch {}
			if (!text) return "";
			return abs && !href.startsWith("#") ? `[${text}](${abs})` : text;
		})
		.replace(/<h([1-6])\b[^>]*>/gi, (_m, n: string) => `\n\n${"#".repeat(Number(n))} `)
		.replace(/<li\b[^>]*>/gi, "\n- ")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/?(p|div|section|article|main|header|ul|ol|table|tr|blockquote|pre|h[1-6]|dl|dt|dd|figure|figcaption)\b[^>]*>/gi, "\n\n")
		.replace(/<\/t[dh]\s*>/gi, " | ")
		.replace(/<[^>]+>/g, "");
	const text = decodeEntities(body)
		.replace(/[ \t\f\v\r\u00a0]+/g, " ")
		.replace(/ *\n */g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return { title: title ? decodeEntities(title).replace(/\s+/g, " ").trim() : undefined, text };
}
