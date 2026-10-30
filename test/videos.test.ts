import assert from "node:assert/strict";
import { existsSync, readFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { checkVideos, fileName, saveVideos, sweepUploads, videoBlocks, withoutVideoNotes } from "../src/videos.ts";
import { PNG, tempDir } from "./helpers.ts";

/** Enough of an MP4 to pass the check: a box whose type is ftyp. */
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42"), Buffer.alloc(12)]).toString("base64");
const mp4 = { name: "Screen Recording 2026-10-29 at 2.15.03 PM.mov", mimeType: "video/mp4", data: MP4, seconds: 23.4, frames: [{ mimeType: "image/png", data: PNG, at: 0 }, { mimeType: "image/png", data: PNG, at: 65.2 }] };

test("videos are checked: their type, that they're base64 and that type, their size and count, and their frames", () => {
	assert.doesNotThrow(() => checkVideos([mp4]));
	assert.doesNotThrow(() => checkVideos([{ name: "a.webm", mimeType: "video/webm", data: Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1]).toString("base64") }]));
	assert.throws(() => checkVideos([{ ...mp4, mimeType: "video/x-msvideo" }]), /x-msvideo; send MP4, QuickTime or WebM/);
	assert.throws(() => checkVideos([{ ...mp4, mimeType: "video/webm" }]), /isn't a WebM/);
	assert.throws(() => checkVideos([{ ...mp4, data: PNG }]), /isn't a MP4/);
	assert.throws(() => checkVideos([{ ...mp4, data: "not base64!" }]), /isn't base64/);
	assert.throws(() => checkVideos([mp4, mp4, mp4]), /at most 2 videos/);
	assert.throws(() => checkVideos([{ ...mp4, frames: Array.from({ length: 7 }, () => mp4.frames[0]!) }]), /at most 6 frames/);
	assert.throws(() => checkVideos([mp4, { ...mp4, frames: [{ mimeType: "image/jpeg", data: PNG, at: 1 }] }]), /video 2's frames: the image isn't a JPEG/);
	assert.throws(() => checkVideos([{ ...mp4, frames: [{ mimeType: "image/png", data: PNG, at: Number.NaN }] }]), /need a time/);
	const big = Buffer.alloc(40 * 1024 * 1024 + 1);
	big.write("ftyp", 4, "latin1");
	assert.throws(() => checkVideos([{ ...mp4, data: big.toString("base64") }]), /40\.0 MB; the limit is 40 MB/);
});

test("a saved video is named for when it came and what it's called, and the message says where it is", async (t) => {
	assert.equal(fileName("Screen Recording 2026-10-29 at 2.15.03 PM.mov", "video/mp4"), "Screen-Recording-2026-10-29-at-2.15.03-PM.mp4");
	assert.equal(fileName("../../etc/passwd", "video/webm"), "passwd.webm");
	assert.equal(fileName("..", "video/quicktime"), "video.mov");
	const uploads = join(tempDir(t), "uploads");
	const now = new Date("2026-10-29T14:15:03Z");
	const [first, second] = await saveVideos(uploads, 12, [mp4, mp4], now);
	assert.equal(first!.path, join(uploads, "12", "20261029-141503-Screen-Recording-2026-10-29-at-2.15.03-PM.mp4"));
	assert.equal(second!.path, join(uploads, "12", "20261029-141503-2-Screen-Recording-2026-10-29-at-2.15.03-PM.mp4"));
	assert.deepEqual(readFileSync(first!.path), Buffer.from(MP4, "base64"));
	const blocks = videoBlocks([first!]);
	assert.equal(blocks.length, 3, "the note, then its two frames");
	assert.equal(blocks[0]!.type, "text");
	const note = (blocks[0] as { text: string }).text;
	assert.match(note, new RegExp(`<video name="Screen-Recording-2026-10-29-at-2.15.03-PM.mp4" seconds="23.4" path="${first!.path}" until="2026-11-12">`));
	assert.match(note, /2 images after this are frames from it, at 0:00, 1:05\./);
	assert.deepEqual(blocks[1], { type: "image", mimeType: "image/png", data: PNG });
	assert.equal(withoutVideoNotes(`Why does it flicker?${note}`), "Why does it flicker?");
});

test("uploads go 14 days after they came, and a session's directory with them", async (t) => {
	const uploads = join(tempDir(t), "uploads");
	const [old] = await saveVideos(uploads, 3, [mp4]);
	const [fresh] = await saveVideos(uploads, 4, [mp4]);
	const [kept] = await saveVideos(uploads, 4, [mp4]);
	const days = (n: number) => new Date(Date.now() - n * 86_400_000);
	utimesSync(old!.path, days(15), days(15));
	utimesSync(fresh!.path, days(15), days(15));
	utimesSync(kept!.path, days(13), days(13));
	assert.equal(await sweepUploads(uploads), 2);
	assert.equal(existsSync(join(uploads, "3")), false);
	assert.equal(existsSync(fresh!.path), false);
	assert.equal(existsSync(kept!.path), true);
	assert.equal(await sweepUploads(join(uploads, "none")), 0, "no uploads yet is nothing to do");
});
