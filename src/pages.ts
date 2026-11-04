// Visual replies: a page the agent makes, such as a chart, a table, a diagram or a mockup, shown in the session above
// its written answer. The agent calls `publish_page` with a self-contained HTML document; the host seals it and keeps
// it with the session, and amyrlin fetches it over its socket (`conversation.page`) and shows it in a web view. Nothing
// serves pages over HTTP: aludra still serves no web content (docs/plan.md, "Visual replies").
//
// Sealing makes a page stand alone and keeps it off the network. Local images it names by path (in `src` attributes and
// CSS `url()`) are read and inlined as data: URLs, so the page keeps working after the files move; and a
// Content-Security-Policy goes first in its <head>, allowing its own inline scripts, styles, data: images and fonts and
// nothing else, so it can't load anything, call home or reach aludra. Charts are drawn inline (SVG or canvas), or with
// a library inlined into the page.
//
// Each page is a document in the `aludra.pages` family, keyed `<session>/<n>`, so reading one never loads the others.
// The tool's result carries `{ page, title, bytes }` in its details, which is how clients find a page in a transcript.
import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { Type } from "@earendil-works/pi-ai";
import { defineDocFamily, defineExtension, defineTool, type Harness } from "@earendil-works/pi-durable";
import { classifyProtectedPath } from "./protected-paths.ts";

/** A page as stored and as clients get it. */
export type Page = { session: number; page: number; title: string; html: string; bytes: number; createdAt: number; images: number; missing: string[] };

export const MAX_PAGE_BYTES = 5 * 1024 * 1024;
/** One inlined image, at most; the page's own limit still applies. */
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

export const PAGE_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; base-uri 'none'; form-action 'none'";

const IMAGE_TYPES: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".svg": "image/svg+xml",
	".avif": "image/avif",
};

export const Pages = defineDocFamily<{ title: string; html: string; createdAt: number; images: number; missing: string[] }, null>({
	kind: "aludra.pages",
	version: 1,
	scope: "session",
	family: true,
	initial: () => ({ title: "", html: "", createdAt: 0, images: 0, missing: [] }),
});

/** Each session's next page number. */
export const PageCounters = defineDocFamily<{ next: number }, null>({
	kind: "aludra.page-counters",
	version: 1,
	scope: "session",
	family: true,
	initial: () => ({ next: 1 }),
});

/** A reference in `src="…"` or `url(…)` that names a file rather than a URL. */
function isLocal(ref: string): boolean {
	return ref !== "" && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref);
}

/** Reads a file for a page: its size, then its bytes; undefined when it isn't there. */
export type PageFiles = { size(path: string): Promise<number | undefined>; read(path: string): Promise<Uint8Array | undefined> };

/** This machine's files. */
const localFiles: PageFiles = {
	size: (path) => stat(path).then((s) => s.size, () => undefined),
	read: (path) => readFile(path).catch(() => undefined),
};

/** The files a session's tools see: a sandbox session's are in its sandbox, not on this machine. */
export function envFiles(env: ExecutionEnv, context: Context): PageFiles {
	return {
		size: async (path) => {
			const info = await env.fileInfo(path, context);
			return info.ok && info.value.kind === "file" ? info.value.size : undefined;
		},
		read: async (path) => {
			const bytes = await env.readBinaryFile(path, context);
			return bytes.ok ? bytes.value : undefined;
		},
	};
}

/**
 * `html` with local images inlined and the CSP added: the sealed page, how many images went in, and the references that
 * couldn't be (missing, not an image, protected, too big). Relative paths are from `cwd`, and files are read through
 * `files`: this machine's, unless the session's tools run elsewhere.
 */
export async function sealPage(html: string, cwd: string, files: PageFiles = localFiles): Promise<{ html: string; images: number; missing: string[] }> {
	const refs = new Set<string>();
	for (const match of html.matchAll(/\bsrc\s*=\s*(["'])(.*?)\1/gi)) refs.add(match[2]!);
	for (const match of html.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi)) refs.add(match[2]!);
	const inlined = new Map<string, string>();
	const missing: string[] = [];
	for (const ref of refs) {
		if (!isLocal(ref)) continue;
		const path = decodeURI(ref.startsWith("file://") ? ref.slice(7) : ref);
		const full = isAbsolute(path) ? path : resolve(cwd, path);
		const type = IMAGE_TYPES[extname(full).toLowerCase()];
		if (type === undefined || classifyProtectedPath(full, cwd) !== undefined) {
			missing.push(ref);
			continue;
		}
		const size = await files.size(full);
		const bytes = size === undefined || size > MAX_IMAGE_BYTES ? undefined : await files.read(full);
		if (bytes === undefined) {
			missing.push(ref);
			continue;
		}
		inlined.set(ref, `data:${type};base64,${Buffer.from(bytes).toString("base64")}`);
	}
	let sealed = html;
	for (const [ref, data] of inlined) {
		sealed = sealed.replaceAll(`"${ref}"`, `"${data}"`).replaceAll(`'${ref}'`, `'${data}'`).replace(new RegExp(`url\\(\\s*${ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\)`, "g"), `url("${data}")`);
	}
	return { html: withPolicy(sealed), images: inlined.size, missing };
}

/** The page with the CSP as the first thing in its <head>, so it governs everything after; a fragment gets a document. */
export function withPolicy(html: string): string {
	const meta = `<meta http-equiv="Content-Security-Policy" content="${PAGE_CSP}">`;
	if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (head) => `${head}${meta}`);
	if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (open) => `${open}<head>${meta}</head>`);
	return `<!doctype html><html><head><meta charset="utf-8">${meta}</head><body>${html}</body></html>`;
}

export const PAGE_TOOL_DESCRIPTION = [
	"Show the user a page in the session, above your written answer: a chart, a table, a diagram, a mockup or a collage of screenshots, when that says it better than text. Write one self-contained HTML document; it's shown in a web view about the width of a chat column, which the user can open full screen.",
	"The page can't load anything from the network: no CDN scripts, fonts or images. Draw charts as inline SVG or on a canvas, or inline a small library. Name local images by absolute or project-relative path in src or url(); they're copied into the page. Inline scripts and styles run.",
	"Match the user's app: dark background (#0d0d0f), light text, a sans-serif font. Keep it readable at about 700 px wide. Still write your answer in text as usual; the page goes with it.",
].join("\n\n");

export function pagesExtension(options: { harness: () => Harness; context: Context }) {
	const publish = defineTool({
		name: "publish_page",
		description: PAGE_TOOL_DESCRIPTION,
		parameters: Type.Object({
			title: Type.String({ description: "A short title, shown above the page" }),
			html: Type.String({ description: "The whole page: one self-contained HTML document" }),
		}),
		replay: "safe",
		async execute({ title, html }, api, context) {
			if (html.trim() === "") return { output: [{ type: "text", text: "The page is empty." }], isError: true };
			const agent = await api.agent(context);
			// Through the call's environment, so a sandbox session's page has the sandbox's images and none of this machine's.
			const sealed = await sealPage(html, agent.cwd ?? process.cwd(), api.env === undefined ? undefined : envFiles(api.env, context));
			const bytes = Buffer.byteLength(sealed.html, "utf8");
			if (bytes > MAX_PAGE_BYTES) {
				return { output: [{ type: "text", text: `The page is ${(bytes / 1048576).toFixed(1)} MB with its images; the limit is ${MAX_PAGE_BYTES / 1048576} MB. Use fewer or smaller images.` }], isError: true };
			}
			const session = Number(api.conversationId);
			// The number is memoized, so a rerun after a restart writes the same page rather than a second one.
			const page = (await api.memo<number>("aludra.page", context)) ?? (await api.memo<number>("aludra.page", await nextPage(session), context));
			const createdAt = Date.now();
			await options.harness().root(options.context).then((root) =>
				root.commit(async (tx) => {
					const doc = await tx.doc(Pages, `${session}/${page}`, null);
					doc.title = title.trim().slice(0, 120) || "Page";
					doc.html = sealed.html;
					doc.createdAt = createdAt;
					doc.images = sealed.images;
					doc.missing = sealed.missing;
				}, options.context),
			);
			const notes = sealed.missing.length === 0 ? "" : ` These weren't found or aren't images, so they show broken: ${sealed.missing.join(", ")}.`;
			return {
				output: [{ type: "text", text: `Published page ${page}, "${title}" (${(bytes / 1024).toFixed(0)} KB${sealed.images === 0 ? "" : `, ${sealed.images} image${sealed.images === 1 ? "" : "s"} inlined`}). The user sees it above your answer.${notes}` }],
				details: { page, title, bytes },
			};
		},
	});

	/** Takes session `id`'s next page number. */
	async function nextPage(id: number): Promise<number> {
		const root = await options.harness().root(options.context);
		return root.commit(async (tx) => {
			const counter = await tx.doc(PageCounters, String(id), null);
			const page = counter.next;
			counter.next += 1;
			return page;
		}, options.context);
	}

	/** Page `page` of session `id`, or undefined if there's no such page. */
	async function read(id: number, page: number): Promise<Page | undefined> {
		const doc = await options.harness().snapshot(Pages, `${id}/${page}`, options.context);
		if (doc === undefined || doc.html === "") return undefined;
		return { session: id, page, title: doc.title, html: doc.html, bytes: Buffer.byteLength(doc.html, "utf8"), createdAt: doc.createdAt, images: doc.images, missing: [...doc.missing] };
	}

	return { extension: defineExtension({ name: "aludra-pages", tools: [publish] }), read };
}
