// Images for a message: each is drawn on a canvas at no more than Claude's recommended 1568 px on its long side, then
// sent as PNG if it was one (it may have transparency) or JPEG, which also turns a phone's HEIC photo into something
// Claude takes. The host checks them again (src/images.ts).
import type { ImageAt } from "../../src/api-types.ts";

export type Attached = { mimeType: string; data: string; url: string };

const LONG_EDGE = 1568;
export const MAX_IMAGES = 8;
/** A PNG bigger than this goes as JPEG instead, to stay well under the 5 MB limit. */
const MAX_PNG_BYTES = 3 * 1024 * 1024;

function blobOf(canvas: HTMLCanvasElement, type: string): Promise<Blob> {
	return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob === null ? reject(new Error("The image couldn't be encoded")) : resolve(blob)), type, 0.85));
}

function base64Of(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
		reader.onerror = () => reject(reader.error ?? new Error("The image couldn't be read"));
		reader.readAsDataURL(blob);
	});
}

/** A picked, pasted or dropped image, ready to send. */
export async function prepareImage(file: Blob): Promise<Attached> {
	const source = URL.createObjectURL(file);
	try {
		const image = new Image();
		image.src = source;
		await image.decode();
		const scale = Math.min(1, LONG_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
		const canvas = document.createElement("canvas");
		canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
		canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
		const context = canvas.getContext("2d");
		if (context === null) throw new Error("The image couldn't be drawn");
		let png = file.type === "image/png";
		// JPEG has no transparency: what was clear goes white, not black.
		if (!png) {
			context.fillStyle = "#fff";
			context.fillRect(0, 0, canvas.width, canvas.height);
		}
		context.drawImage(image, 0, 0, canvas.width, canvas.height);
		let blob = await blobOf(canvas, png ? "image/png" : "image/jpeg");
		if (png && blob.size > MAX_PNG_BYTES) {
			context.globalCompositeOperation = "destination-over";
			context.fillStyle = "#fff";
			context.fillRect(0, 0, canvas.width, canvas.height);
			png = false;
			blob = await blobOf(canvas, "image/jpeg");
		}
		return { mimeType: png ? "image/png" : "image/jpeg", data: await base64Of(blob), url: URL.createObjectURL(blob) };
	} finally {
		URL.revokeObjectURL(source);
	}
}

/** Where the app gets an image of the transcript from. */
export const imageSrc = (session: number, at: ImageAt) => `/api/sessions/${session}/images/${at.entry}/${at.message}/${at.block}`;
