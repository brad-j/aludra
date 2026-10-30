// Images in sessions: ones the user attaches to a message, and ones a tool returns (reading a screenshot). They're
// stored where Pi Durable stores the message, as base64 image blocks, and the bridge hands them to Claude Code. The
// transcripts send only where each image is (entry, message, block); the apps fetch the bytes when they show one.
//
// The apps scale an image to Claude's recommended 1568 px before sending it; the host checks what arrives.
import type { ImageContent, TextContent, UserMessage } from "@earendil-works/pi-ai";
import type { ConversationId, EntryId } from "@earendil-works/pi-durable";
import { ParseError } from "./parse.ts";

export type ImageInput = { mimeType: string; data: string };

/** Where an image is in a conversation: its entry, the message in the entry, and the block in the message. */
export type ImageAt = { entry: number; message: number; block: number; mimeType: string };

export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
/** Claude's limit for one image. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGES = 8;

/** Whether the bytes are the type they're said to be: Claude refuses a mismatch, which would fail the run. */
function looksLike(mimeType: string, bytes: Buffer): boolean {
	const ascii = (start: number, end: number) => bytes.subarray(start, end).toString("latin1");
	switch (mimeType) {
		case "image/png":
			return bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
		case "image/jpeg":
			return bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
		case "image/gif":
			return ascii(0, 4) === "GIF8";
		case "image/webp":
			return ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
		default:
			return false;
	}
}

/** Checks images from the apps; throws a ParseError (a 400) saying what's wrong with the first bad one. */
export function checkImages(images: readonly ImageInput[]): void {
	if (images.length > MAX_IMAGES) throw new ParseError(`at most ${MAX_IMAGES} images in a message`);
	images.forEach((image, index) => {
		const which = images.length === 1 ? "the image" : `image ${index + 1}`;
		if (!(IMAGE_TYPES as readonly string[]).includes(image.mimeType)) throw new ParseError(`${which} is ${image.mimeType || "of no type"}; send PNG, JPEG, GIF or WebP`);
		if (!/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) throw new ParseError(`${which} isn't base64`);
		const bytes = Buffer.from(image.data, "base64");
		if (bytes.length === 0) throw new ParseError(`${which} is empty`);
		if (bytes.length > MAX_IMAGE_BYTES) throw new ParseError(`${which} is ${(bytes.length / 1048576).toFixed(1)} MB; the limit is 5 MB`);
		if (!looksLike(image.mimeType, bytes)) throw new ParseError(`${which} isn't a ${image.mimeType.slice(6).toUpperCase()}`);
	});
}

/**
 * A message's content: the text alone, or the text, then the images, then `after` (its videos' notes and frames,
 * src/videos.ts). Throws if there's nothing, or an image is bad.
 */
export function messageContent(text: string, images: readonly ImageInput[] = [], after: readonly (TextContent | ImageContent)[] = []): UserMessage["content"] {
	checkImages(images);
	if (images.length === 0 && after.length === 0) {
		if (text.trim() === "") throw new ParseError("the message is empty");
		return text;
	}
	const blocks: (TextContent | ImageContent)[] = text.trim() === "" ? [] : [{ type: "text", text }];
	for (const image of images) blocks.push({ type: "image", mimeType: image.mimeType, data: image.data });
	return [...blocks, ...after];
}

/** A title from a first message: its first line, or what it attaches. */
export function titleOf(text: string, images: readonly ImageInput[] = [], videos = 0): string {
	const line = text.split("\n").find((l) => l.trim() !== "")?.trim();
	if (line !== undefined) return line.slice(0, 80);
	if (images.length === 0) return videos === 1 ? "A video" : `${videos} videos`;
	return images.length === 1 ? "An image" : `${images.length} images`;
}

/** The image blocks of some content, where each is. */
export function imagesIn(content: UserMessage["content"] | readonly { type: string; mimeType?: string }[], entry: number, message: number): ImageAt[] {
	if (typeof content === "string") return [];
	return content.flatMap((block, index) => (block.type === "image" ? [{ entry, message, block: index, mimeType: (block as ImageContent).mimeType }] : []));
}

/** What `entries` returns for one entry, as much as finding an image needs. */
type EntryReader = (conversation: ConversationId, entry: EntryId) => Promise<{ model?: readonly { content?: unknown }[] } | undefined>;

/** The image at `at` in a conversation, or undefined if there's none there. */
export async function readImage(read: EntryReader, conversation: ConversationId, entry: EntryId, message: number, block: number): Promise<ImageInput | undefined> {
	const found = await read(conversation, entry);
	const content = found?.model?.[message]?.content;
	if (!Array.isArray(content)) return undefined;
	const image = content[block] as { type?: string; mimeType?: string; data?: string } | undefined;
	if (image?.type !== "image" || typeof image.data !== "string" || typeof image.mimeType !== "string") return undefined;
	return { mimeType: image.mimeType, data: image.data };
}
