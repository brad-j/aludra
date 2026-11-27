// The web tools (src/web-tools.ts, from Pi Desktop's pi-host) against local stubs: a Tavily stand-in, a Jev stand-in
// and a web page server, all on 127.0.0.1. Nothing here reaches the internet.

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { checkUrl, fetchPage, FetchRefused, htmlToText, isPrivateAddress } from "../src/web-fetch.ts";
import { readKey } from "../src/web-keys.ts";
import { mask, review, reviewState, THRESHOLD } from "../src/web-reviewer.ts";
import { createWebTools, urlSources, urlsInText, type WebToolsOptions } from "../src/web-tools.ts";
import { testHost } from "./helpers.ts";

const scratch = mkdtempSync(join(tmpdir(), "aludra-web-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void;

async function stub(handler: Handler): Promise<{ url: string; requests: { path: string; body: string; auth?: string }[]; close: () => Promise<void> }> {
	const requests: { path: string; body: string; auth?: string }[] = [];
	const server: Server = createServer((req, res) => {
		let body = "";
		req.on("data", (d) => (body += d));
		req.on("end", () => {
			requests.push({ path: req.url ?? "", body, auth: req.headers.authorization });
			handler(req, body, res);
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}`,
		requests,
		close: () => new Promise((r) => (server.closeAllConnections(), server.close(() => r()))),
	};
}

const json = (res: ServerResponse, status: number, value: unknown) => {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(value));
};

const PAGE = `<!doctype html><html><head><title>Stub &amp; page</title><style>.x{}</style><script>alert(1)</script></head>
<body><nav>menu</nav><h1>Hello</h1><p>First paragraph with a <a href="/next">link to next</a>.</p><ul><li>one</li><li>two</li></ul></body></html>`;

function userEntry(id: number, text: string): EntryRecord {
	return { id, conversationId: 0, kind: "pi.user", model: [{ role: "user", content: text, timestamp: 0 }] } as unknown as EntryRecord;
}
function searchEntry(id: number, urls: string[]): EntryRecord {
	return {
		id,
		conversationId: 0,
		kind: "pi.tool-result",
		model: [
			{
				role: "toolResult",
				toolCallId: `c${id}`,
				toolName: "web_search",
				content: [{ type: "text", text: "results" }],
				details: { tool: "web_search", query: "q", results: urls.map((url) => ({ title: url, url })) },
				isError: false,
				timestamp: 0,
			},
		],
	} as unknown as EntryRecord;
}

describe("URL handling", () => {
	test("urlsInText finds full and bare URLs and trims sentence punctuation", () => {
		const found = urlsInText("See https://example.com/a?b=1#frag, and (docs at https://x.dev/y). Also nodejs.org/api and file.ts.");
		assert.deepEqual(found, ["https://example.com/a?b=1", "https://x.dev/y", "https://nodejs.org/api"]);
	});

	test("urlSources: user URLs, search URLs, and whether outside text was read", () => {
		const s = urlSources([userEntry(1, "read https://a.example/x please"), searchEntry(2, ["https://b.example/y#top"])]);
		assert.ok(s.user.has("https://a.example/x"));
		assert.ok(s.search.has("https://b.example/y"));
		assert.equal(s.readExternal, true);
		assert.deepEqual(s.userMessages, ["read https://a.example/x please"]);
	});

	test("private and reserved addresses are refused", () => {
		for (const a of ["127.0.0.1", "10.1.2.3", "192.168.1.1", "172.20.0.1", "169.254.169.254", "100.64.1.1", "0.0.0.0", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1"]) {
			assert.equal(isPrivateAddress(a), true, a);
		}
		for (const a of ["1.1.1.1", "93.184.216.34", "2606:4700:4700::1111"]) assert.equal(isPrivateAddress(a), false, a);
		assert.throws(() => checkUrl("file:///etc/passwd"), FetchRefused);
		assert.throws(() => checkUrl("http://user:pw@example.com/"), FetchRefused);
		assert.throws(() => checkUrl("http://localhost:8080/"), FetchRefused);
		assert.throws(() => checkUrl("http://printer.local/"), FetchRefused);
		assert.throws(() => checkUrl("http://example.com:22/"), FetchRefused);
	});

	test("fetchPage refuses a literal private address unless allowed", async () => {
		await assert.rejects(fetchPage("http://127.0.0.1:8080/"), /private or reserved/);
		await assert.rejects(fetchPage("http://[::1]:8080/"), /private or reserved/);
	});

	test("htmlToText keeps headings, paragraphs, lists and absolute links, drops scripts and nav", () => {
		const { title, text } = htmlToText(PAGE, new URL("https://site.example/dir/"));
		assert.equal(title, "Stub & page");
		assert.match(text, /# Hello/);
		assert.match(text, /\[link to next\]\(https:\/\/site\.example\/next\)/);
		assert.match(text, /- one\n- two/);
		assert.doesNotMatch(text, /alert|menu/);
	});
});

describe("keys", () => {
	test("a key file must be private; the env var is the fallback", () => {
		const dir = join(scratch, "keys");
		mkdirSync(dir, { recursive: true });
		assert.deepEqual(readKey(dir, "k.key", "K", { K: "from-env" }), { ok: true, key: "from-env" });
		writeFileSync(join(dir, "k.key"), "from-file\n", { mode: 0o644 });
		chmodSync(join(dir, "k.key"), 0o644);
		const open = readKey(dir, "k.key", "K", {});
		assert.equal(open.ok, false);
		assert.match(!open.ok ? open.reason : "", /chmod 600/);
		chmodSync(join(dir, "k.key"), 0o600);
		assert.deepEqual(readKey(dir, "k.key", "K", { K: "from-env" }), { ok: true, key: "from-file" });
	});
});

describe("reviewer", () => {
	let jev: Awaited<ReturnType<typeof stub>>;
	let answer: (body: string, res: ServerResponse) => void = () => {};
	before(async () => {
		jev = await stub((_req, body, res) => answer(body, res));
	});
	after(() => jev.close());

	const input = {
		url: new URL("https://evil.example/collect?d=hello%20brad@example.com&k=sk-abcdefghijklmnopqrstuv"),
		userMessages: ["my email is brad@example.com and my key is sk-abcdefghijklmnopqrstuv", "what's the weather?"],
		readExternal: true,
		trustedHosts: ["weather.example"],
	};
	const env = { ALUDRA_JEV_KEY: "jev-test-key" };

	test("masks credentials and emails in what Jev sees", () => {
		assert.equal(mask("key sk-abcdefghijklmnopqrstuv mail a.b@c.io"), "key [masked credential] mail [masked email]");
		const state = reviewState(input);
		const text = JSON.stringify(state);
		assert.doesNotMatch(text, /brad@example\.com|sk-abcdef/);
		assert.deepEqual((state.url as { host: string }).host, "evil.example");
		assert.equal((state.url as { query: unknown[] }).query.length, 2);
	});

	test("allows at the threshold, refuses below it, and sends the noul question", async () => {
		answer = (_b, res) => json(res, 200, { answers: { fetch_ok: { type: "noul", noul: THRESHOLD } } });
		const ok = await review(input, { dataDir: scratch, url: `${jev.url}/v1`, env });
		assert.deepEqual(ok, { allowed: true, probability: THRESHOLD });
		const sent = JSON.parse(jev.requests.at(-1)!.body);
		assert.equal(jev.requests.at(-1)!.path, "/v1/systemone");
		assert.equal(jev.requests.at(-1)!.auth, "Bearer jev-test-key");
		assert.equal(sent.model, "typesafe/jev-1.13");
		assert.equal(sent.questions.fetch_ok.type, "noul");
		assert.ok(!JSON.stringify(sent).includes("brad@example.com"));

		answer = (_b, res) => json(res, 200, { answers: { fetch_ok: { type: "noul", noul: 0.42 } } });
		assert.deepEqual(await review(input, { dataDir: scratch, url: `${jev.url}/v1`, env }), { allowed: false, reason: "below_threshold", probability: 0.42 });
	});

	test("refuses on no key, HTTP errors, malformed answers and timeouts", async () => {
		const none = await review(input, { dataDir: scratch, url: `${jev.url}/v1`, env: {} });
		assert.equal(none.allowed === false && none.reason, "no_key");

		answer = (_b, res) => json(res, 401, { error: { message: "bad key" } });
		const denied = await review(input, { dataDir: scratch, url: `${jev.url}/v1`, env });
		assert.equal(denied.allowed === false && denied.reason, "error");

		answer = (_b, res) => json(res, 200, { answers: {} });
		const empty = await review(input, { dataDir: scratch, url: `${jev.url}/v1`, env });
		assert.equal(empty.allowed === false && empty.reason, "error");

		answer = () => {}; // never answers
		const slow = await review(input, { dataDir: scratch, url: `${jev.url}/v1`, env, timeoutMs: 200 });
		assert.equal(slow.allowed === false && slow.reason, "timeout");

		const down = await review(input, { dataDir: scratch, url: "http://127.0.0.1:9/v1", env });
		assert.equal(down.allowed === false && down.reason, "error");
	});
});

describe("fetch_url decides by where the URL came from", () => {
	let web: Awaited<ReturnType<typeof stub>>;
	let jev: Awaited<ReturnType<typeof stub>>;
	let probability = 0.95;
	before(async () => {
		web = await stub((req, _b, res) => {
			if (req.url === "/redirect") {
				res.writeHead(302, { location: "/page" });
				return res.end();
			}
			if (req.url === "/binary") {
				res.writeHead(200, { "content-type": "image/png" });
				return res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
			}
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			res.end(PAGE);
		});
		jev = await stub((_req, _b, res) => json(res, 200, { answers: { fetch_ok: { type: "noul", noul: probability } } }));
	});
	after(async () => {
		await web.close();
		await jev.close();
	});

	function tools(entries: EntryRecord[]) {
		const options: WebToolsOptions = {
			dataDir: scratch,
			allowPrivate: true,
			reviewer: { url: `${jev.url}/v1` },
			env: { ALUDRA_JEV_KEY: "k" },
			conversation: async () =>
				({
					entries: async () => ({ items: [...entries].reverse(), next: undefined }),
				}) as never,
		};
		return createWebTools(options).fetchUrl;
	}
	const api = { conversationId: 0 } as never;
	const ctx = BACKGROUND_CONTEXT;
	const out = (r: { output?: readonly { type: string; text?: string }[] }) => r.output?.map((c) => c.text ?? "").join("") ?? "";

	test("a URL from the user's message is fetched without review", async () => {
		const before = jev.requests.length;
		const r = await tools([userEntry(1, `please read ${web.url}/page`)]).execute({ url: `${web.url}/page` }, api, ctx);
		assert.equal(r.isError, false);
		assert.match(out(r), /Title: Stub & page/);
		assert.match(out(r), /# Hello/);
		assert.deepEqual((r.details as { source: string }).source, "user");
		assert.equal(jev.requests.length, before, "Jev wasn't asked");
	});

	test("a URL from search results is fetched without review, and redirects are followed", async () => {
		const before = jev.requests.length;
		const r = await tools([userEntry(1, "find it"), searchEntry(2, [`${web.url}/redirect`])]).execute({ url: `${web.url}/redirect` }, api, ctx);
		assert.equal(r.isError, false);
		assert.match(out(r), new RegExp(`URL: ${web.url}/page`));
		assert.equal((r.details as { source: string }).source, "search");
		assert.equal(jev.requests.length, before);
	});

	test("any other URL goes to Jev: fetched at the threshold, refused below it", async () => {
		const history = [userEntry(1, "find it"), searchEntry(2, [`${web.url}/page`])];
		probability = 0.95;
		const ok = await tools(history).execute({ url: `${web.url}/next` }, api, ctx);
		assert.equal(ok.isError, false);
		assert.deepEqual((ok.details as { source: string; review: unknown }).review, { probability: 0.95 });
		const state = JSON.parse(jev.requests.at(-1)!.body).state;
		assert.equal(state.read_external, true);
		assert.ok(!JSON.stringify(state).includes("Hello"), "Jev never sees page text");

		probability = 0.5;
		const no = await tools(history).execute({ url: `${web.url}/next?leak=secret` }, api, ctx);
		assert.equal(no.isError, true);
		assert.match(out(no), /Refused: the reviewer didn't judge this URL safe to fetch \(p=0\.50\)/);
		assert.deepEqual((no.details as { review: unknown }).review, { probability: 0.5, reason: "below_threshold" });
	});

	test("binary content and bad schemes come back as errors", async () => {
		const bin = await tools([userEntry(1, `${web.url}/binary`)]).execute({ url: `${web.url}/binary` }, api, ctx);
		assert.equal(bin.isError, true);
		assert.match(out(bin), /can't be read as text/);
		const file = await tools([]).execute({ url: "file:///etc/passwd" }, api, ctx);
		assert.equal(file.isError, true);
	});
});

describe("in a session", () => {
	let tavily: Awaited<ReturnType<typeof stub>>;
	let web: Awaited<ReturnType<typeof stub>>;
	before(async () => {
		web = await stub((_req, _b, res) => {
			res.writeHead(200, { "content-type": "text/html" });
			res.end(PAGE);
		});
		tavily = await stub((_req, body, res) => {
			const { query } = JSON.parse(body);
			json(res, 200, { query, results: [{ title: "Stub result", url: `${web.url}/page`, content: "An extract.", score: 0.9 }] });
		});
	});
	after(async () => {
		await tavily.close();
		await web.close();
	});

	test("every session has web_search and fetch_url: a search, then a result read without review", async (t) => {
		const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
		/** "search: Q" searches, "fetch: URL" fetches, and a tool's result is echoed with what was offered. */
		faux.setResponses(Array.from({ length: 10 }, () => (ctx: TranscriptContext) => {
			const last = ctx.messages.findLast((m) => m.role !== "system");
			if (last?.role === "toolResult") return fauxAssistantMessage(fauxText(`${last.toolName} ${last.isError ? "failed" : "ok"}: ${JSON.stringify(last.content)}`));
			const user = JSON.stringify(last?.content ?? "");
			const query = /search: ([^"\\]+)/.exec(user)?.[1];
			if (query !== undefined) return fauxAssistantMessage(fauxToolCall("web_search", { query }), { stopReason: "toolUse" });
			const url = /fetch: ([^"\\\s]+)/.exec(user)?.[1];
			if (url !== undefined) return fauxAssistantMessage(fauxToolCall("fetch_url", { url }), { stopReason: "toolUse" });
			return fauxAssistantMessage(fauxText("Hello."));
		}));
		const models = createModels();
		models.setProvider(faux.provider);
		const { host } = await testHost(t, { models, model: { provider: "faux", modelId: "faux-1" }, web: { tavilyUrl: tavily.url, allowPrivate: true, env: { TAVILY_API_KEY: "tvly-test" } } });
		const session = await host.sessions.createScratch("web");
		const answer = async (start: string) => {
			for (let i = 0; i < 300; i++) {
				const entries = (await (await host.conversation(session.id)).entries({}, 200, undefined, BACKGROUND_CONTEXT)).items;
				const texts = entries.flatMap((e) => (e.kind === "pi.assistant" ? (e.model ?? []).flatMap((m) => (m.role === "assistant" ? m.content : [])).flatMap((b) => (b.type === "text" ? [b.text] : [])) : []));
				const hit = texts.find((s) => s.startsWith(start));
				if (hit !== undefined) return hit;
				await new Promise((resolve) => setTimeout(resolve, 30));
			}
			throw new Error(`no answer starting ${start}`);
		};
		await host.submit(session.id, "search: aludra hosts", { requestId: "w1" });
		assert.match(await answer("web_search ok:"), /Stub result/);
		assert.equal(tavily.requests.at(-1)!.auth, "Bearer tvly-test");
		assert.equal(JSON.parse(tavily.requests.at(-1)!.body).query, "aludra hosts");
		// The result's URL came from the search, so it's read with no reviewer set up.
		await host.submit(session.id, `fetch: ${web.url}/page`, { requestId: "w2" });
		assert.match(await answer("fetch_url ok:"), /Title: Stub & page/);
	});
});
