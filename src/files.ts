// Files in sessions: anything the user attaches that isn't an image or a video (a log, a PDF, a CSV, a zip), and text
// too long to send as a message. Like videos (src/videos.ts), each is saved in the data directory and the message
// carries a note saying where, which the agent reads with its own tools; the bytes never go to the model on their own.
//
// The note is a text block `<file name="…" bytes="…" path="…" until="…">…</file>`; a client can show it as a chip.
// Uploads go UPLOAD_DAYS after they arrive (sweepUploads in src/videos.ts).
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TextContent } from "@earendil-works/pi-ai";
import { ParseError } from "./parse.ts";
import { UPLOAD_DAYS } from "./videos.ts";

export type FileInput = { name: string; mimeType?: string; data: string };
/** A file saved on this machine. `pasted` is message text moved to a file because it was too long. */
export type SavedFile = { path: string; name: string; bytes: number; until: Date; mimeType?: string; pasted?: boolean };

export const MAX_FILES = 20;
/** All of a message's files together. With the images and videos it still fits amyrlin's socket frame (src/api.ts). */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** Message text longer than this, in UTF-8 bytes, is saved as a file instead (T3 Code's threshold for pastes). */
export const PASTE_BYTES = 32 * 1024;
/** How much of moved text the message keeps, so its opening words (usually what to do with it) stay in view. */
const PREVIEW_CHARS = 1500;
const DAY = 86_400_000;

/** Checks files from a client; throws a ParseError (a 400) saying what's wrong with the first bad one. */
export function checkFiles(files: readonly FileInput[]): void {
	if (files.length > MAX_FILES) throw new ParseError(`at most ${MAX_FILES} files in a message`);
	let total = 0;
	files.forEach((file, index) => {
		const which = files.length === 1 ? "the file" : `file ${index + 1}`;
		if (file.name.trim() === "") throw new ParseError(`${which} needs a name`);
		if (!/^[A-Za-z0-9+/]*={0,2}$/.test(file.data)) throw new ParseError(`${which} isn't base64`);
		const bytes = Buffer.byteLength(file.data, "base64");
		if (bytes === 0) throw new ParseError(`${which} is empty`);
		total += bytes;
	});
	if (total > MAX_FILE_BYTES) throw new ParseError(`the file${files.length === 1 ? " is" : "s are"} ${(total / 1048576).toFixed(1)} MB; the limit is ${MAX_FILE_BYTES / 1048576} MB`);
}

/** A file name from what the user called it: letters, digits, dots, dashes and underscores, keeping a short extension. */
export function safeName(name: string): string {
	const last = name.split(/[/\\]/).at(-1) ?? "";
	const extension = /\.([A-Za-z0-9]{1,10})$/.exec(last)?.[1];
	const base = (extension === undefined ? last : last.slice(0, -extension.length - 1)).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 80);
	return `${base || "file"}${extension === undefined ? "" : `.${extension.toLowerCase()}`}`;
}

/** Whether text is long enough to be moved to a file. */
export function isLong(text: string): boolean {
	return Buffer.byteLength(text, "utf8") > PASTE_BYTES;
}

/**
 * Saves files to `<uploads>/<session>/`, each named for when it came and what it's called; `pasted`, if given, is
 * message text saved as `message.txt` first.
 */
export async function saveFiles(uploads: string, session: number, files: readonly FileInput[], pasted?: string, now = new Date()): Promise<SavedFile[]> {
	if (files.length === 0 && pasted === undefined) return [];
	const dir = join(uploads, String(session));
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const stamp = now.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
	const until = new Date(now.getTime() + UPLOAD_DAYS * DAY);
	const saved: SavedFile[] = [];
	const write = async (name: string, bytes: Buffer, extra: Partial<SavedFile>) => {
		let path = join(dir, `${stamp}-${name}`);
		for (let n = 2; await exists(path); n++) path = join(dir, `${stamp}-${n}-${name}`);
		await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
		saved.push({ path, name, bytes: bytes.length, until, ...extra });
	};
	if (pasted !== undefined) await write("message.txt", Buffer.from(pasted, "utf8"), { pasted: true, mimeType: "text/plain" });
	for (const file of files) await write(safeName(file.name), Buffer.from(file.data, "base64"), file.mimeType === undefined ? {} : { mimeType: file.mimeType });
	return saved;
}

async function exists(path: string): Promise<boolean> {
	return stat(path).then(() => true, () => false);
}

/** A size as people read it. */
function size(bytes: number): string {
	return bytes < 1024 ? `${bytes} bytes` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
}

/** What a message carries for its saved files: a note for each. */
export function fileBlocks(saved: readonly SavedFile[]): TextContent[] {
	return saved.map((file) => {
		const day = file.until.toISOString().slice(0, 10);
		const type = file.mimeType === undefined ? "" : ` type="${file.mimeType}"`;
		const what = file.pasted === true
			? `The user's message was too long to send whole (${size(file.bytes)}), so all of it is saved in this file; what's above is only its start. Read the file for the rest.`
			: `The user attached a file (${size(file.bytes)}), saved on this machine until ${day}. Read it with your tools; for a binary format, use a command that understands it.`;
		return { type: "text", text: `\n\n<file name="${file.name}"${type} bytes="${file.bytes}" path="${file.path}" until="${day}">\n${what}\n</file>` };
	});
}

/** The start of long text, cut at a line break near PREVIEW_CHARS where there is one, kept in the message. */
export function preview(text: string): string {
	const cut = text.slice(0, PREVIEW_CHARS);
	const line = cut.lastIndexOf("\n");
	return `${line > PREVIEW_CHARS / 2 ? cut.slice(0, line) : cut}\n…`;
}

/** Text without its files' notes, for what's written from a message's words, such as its title or the search index. */
export function withoutFileNotes(text: string): string {
	return text.replace(/\s*<file [^>]*>[\s\S]*?<\/file>/g, "");
}
