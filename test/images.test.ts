import assert from "node:assert/strict";
import test from "node:test";
import { checkImages, messageContent, titleOf } from "../src/images.ts";
import { PNG } from "./helpers.ts";

const png = { mimeType: "image/png", data: PNG };

test("a message is its text, or its text and images; one with neither is refused", () => {
	assert.equal(messageContent("hello"), "hello");
	assert.deepEqual(messageContent("look", [png]), [{ type: "text", text: "look" }, { type: "image", mimeType: "image/png", data: PNG }]);
	assert.deepEqual(messageContent("  ", [png]), [{ type: "image", mimeType: "image/png", data: PNG }]);
	assert.throws(() => messageContent("  "), /empty/);
});

test("images are checked: their type, that they're base64, their size and count, and that the bytes are that type", () => {
	assert.doesNotThrow(() => checkImages([png]));
	assert.throws(() => checkImages([{ mimeType: "image/svg+xml", data: PNG }]), /svg\+xml; send PNG, JPEG, GIF or WebP/);
	assert.throws(() => checkImages([{ mimeType: "image/jpeg", data: PNG }]), /isn't a JPEG/);
	assert.throws(() => checkImages([{ mimeType: "image/png", data: "not base64!" }]), /isn't base64/);
	assert.throws(() => checkImages([png, { mimeType: "image/png", data: "" }]), /image 2 is empty/);
	assert.throws(() => checkImages(Array.from({ length: 9 }, () => png)), /at most 8/);
	const big = Buffer.alloc(5 * 1024 * 1024 + 1);
	big.set([0x89, 0x50, 0x4e, 0x47]);
	assert.throws(() => checkImages([{ mimeType: "image/png", data: big.toString("base64") }]), /5\.0 MB; the limit is 5 MB/);
});

test("a first message's title is its first line, or what it attaches", () => {
	assert.equal(titleOf("\n  Fix the header  \nmore"), "Fix the header");
	assert.equal(titleOf("", [png]), "An image");
	assert.equal(titleOf(" ", [png, png]), "2 images");
});
