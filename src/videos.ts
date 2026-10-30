// Videos in sessions: short clips the user attaches, mostly screen recordings of something going wrong. No model takes
// video, so the host saves each to the data directory and the message carries a note saying where it is, followed by
// the frames the app pulled from it as image blocks. An agent that needs more of it pulls frames with ffmpeg.
//
// The note is a text block `<video name="…" seconds="…" path="…" until="…">…</video>`; amyrlin's transcript reads it
// back to show the video as a chip. Uploads go UPLOAD_DAYS after they arrive (sweepUploads); the frames stay.
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { checkImages, type ImageInput } from "./images.ts";
import { ParseError } from "./parse.ts";

/** A frame the app pulled from a video, `at` seconds in. */
export type FrameInput = ImageInput & { at: number };
export type VideoInput = { name: string; mimeType: string; data: string; seconds?: number; frames?: FrameInput[] };
/** A video saved on this machine, and what came with it. */
export type SavedVideo = { path: string; until: Date; video: VideoInput };

export const VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm"] as const;
const EXTENSIONS: Record<string, string> = { "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm" };
/** All of a message's videos together; with its images that keeps it under the socket's frame limit (src/api.ts). */
export const MAX_VIDEO_BYTES = 40 * 1024 * 1024;
export const MAX_VIDEOS = 2;
export const MAX_FRAMES = 6;
export const UPLOAD_DAYS = 14;
const DAY = 86_400_000;

/** Whether the bytes are the type they're said to be: MP4 and QuickTime start with an ftyp box, WebM with EBML's magic. */
function looksLike(mimeType: string, bytes: Buffer): boolean {
	if (mimeType === "video/webm") return bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
	return bytes.subarray(4, 8).toString("latin1") === "ftyp";
}

/** Checks videos from the apps, and their frames; throws a ParseError (a 400) saying what's wrong with the first bad one. */
export function checkVideos(videos: readonly VideoInput[]): void {
	if (videos.length > MAX_VIDEOS) throw new ParseError(`at most ${MAX_VIDEOS} videos in a message`);
	let total = 0;
	videos.forEach((video, index) => {
		const which = videos.length === 1 ? "the video" : `video ${index + 1}`;
		if (!(VIDEO_TYPES as readonly string[]).includes(video.mimeType)) throw new ParseError(`${which} is ${video.mimeType || "of no type"}; send MP4, QuickTime or WebM`);
		if (!/^[A-Za-z0-9+/]*={0,2}$/.test(video.data)) throw new ParseError(`${which} isn't base64`);
		const bytes = Buffer.from(video.data, "base64");
		if (bytes.length === 0) throw new ParseError(`${which} is empty`);
		if (!looksLike(video.mimeType, bytes)) throw new ParseError(`${which} isn't a ${video.mimeType === "video/webm" ? "WebM" : video.mimeType === "video/mp4" ? "MP4" : "QuickTime movie"}`);
		total += bytes.length;
		if (video.seconds !== undefined && !(Number.isFinite(video.seconds) && video.seconds >= 0)) throw new ParseError(`${which}'s seconds should be a length`);
		const frames = video.frames ?? [];
		if (frames.length > MAX_FRAMES) throw new ParseError(`at most ${MAX_FRAMES} frames with a video`);
		if (!frames.every((f) => Number.isFinite(f.at) && f.at >= 0)) throw new ParseError(`${which}'s frames each need a time, at`);
		try {
			checkImages(frames);
		} catch (error) {
			throw new ParseError(`${which}'s frames: ${error instanceof Error ? error.message : String(error)}`);
		}
	});
	if (total > MAX_VIDEO_BYTES) throw new ParseError(`the video${videos.length === 1 ? " is" : "s are"} ${(total / 1048576).toFixed(1)} MB; the limit is ${MAX_VIDEO_BYTES / 1048576} MB`);
}

/** A file name from what the user called it: letters, digits, dots, dashes and underscores, ending in the type's extension. */
export function fileName(name: string, mimeType: string): string {
	const extension = EXTENSIONS[mimeType] ?? "bin";
	const base = (name.split("/").at(-1) ?? "").replace(/\.[A-Za-z0-9]{1,5}$/, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|-+$/g, "").slice(0, 60);
	return `${base || "video"}.${extension}`;
}

/** Saves checked videos to `<uploads>/<session>/`, each named for when it came and what it's called. */
export async function saveVideos(uploads: string, session: number, videos: readonly VideoInput[], now = new Date()): Promise<SavedVideo[]> {
	if (videos.length === 0) return [];
	const dir = join(uploads, String(session));
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const stamp = now.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
	const until = new Date(now.getTime() + UPLOAD_DAYS * DAY);
	const saved: SavedVideo[] = [];
	for (const video of videos) {
		const name = fileName(video.name, video.mimeType);
		let path = join(dir, `${stamp}-${name}`);
		for (let n = 2; await exists(path); n++) path = join(dir, `${stamp}-${n}-${name}`);
		await writeFile(path, Buffer.from(video.data, "base64"), { mode: 0o600, flag: "wx" });
		saved.push({ path, until, video });
	}
	return saved;
}

async function exists(path: string): Promise<boolean> {
	return stat(path).then(() => true, () => false);
}

/** `m:ss`, as the frames' times are written. */
function clock(seconds: number): string {
	const whole = Math.round(seconds);
	return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** What a message carries for its saved videos: each one's note, then its frames. */
export function videoBlocks(saved: readonly SavedVideo[]): (TextContent | ImageContent)[] {
	return saved.flatMap(({ path, until, video }) => {
		const frames = video.frames ?? [];
		const day = until.toISOString().slice(0, 10);
		const seconds = video.seconds === undefined ? "" : ` seconds="${video.seconds.toFixed(1)}"`;
		const shown = frames.length === 0 ? "No frames came with it." : `The ${frames.length === 1 ? "image after this is a frame" : `${frames.length} images after this are frames`} from it, at ${frames.map((f) => clock(f.at)).join(", ")}.`;
		const note = [
			`\n\n<video name="${fileName(video.name, video.mimeType)}"${seconds} path="${path}" until="${day}">`,
			`The user attached a video, saved on this machine until ${day}. ${shown} To see more of it, pull frames with ffmpeg (ffmpeg -ss <seconds> -i <path> -frames:v 1 <out>.png, or -vf fps=2 for a run of them) and read them; ffprobe gives its details.`,
			"</video>",
		].join("\n");
		return [{ type: "text", text: note } as TextContent, ...frames.map((f): ImageContent => ({ type: "image", mimeType: f.mimeType, data: f.data }))];
	});
}

/** Deletes uploads older than UPLOAD_DAYS, and the session directories that leaves empty; returns how many went. */
export async function sweepUploads(uploads: string, now = Date.now()): Promise<number> {
	let removed = 0;
	const sessions = await readdir(uploads, { withFileTypes: true }).catch(() => []);
	for (const session of sessions) {
		if (!session.isDirectory()) continue;
		const dir = join(uploads, session.name);
		const files = await readdir(dir);
		let left = files.length;
		for (const file of files) {
			const path = join(dir, file);
			const info = await stat(path).catch(() => undefined);
			if (info === undefined || now - info.mtimeMs < UPLOAD_DAYS * DAY) continue;
			await rm(path, { force: true });
			removed += 1;
			left -= 1;
		}
		if (left === 0) await rm(dir, { recursive: true, force: true });
	}
	return removed;
}

/** Text without its videos' notes, for what's written from a message's words, such as its title. */
export function withoutVideoNotes(text: string): string {
	return text.replace(/\s*<video [^>]*>[\s\S]*?<\/video>/g, "");
}
