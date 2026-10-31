import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { checkFiles, fileBlocks, isLong, PASTE_BYTES, preview, safeName, saveFiles, withoutFileNotes } from "../src/files.ts";
import { context } from "../src/host.ts";
import { textOf } from "../src/transcript.ts";
import { makeProject, tempDir, testHost } from "./helpers.ts";

const b64 = (text: string) => Buffer.from(text).toString("base64");

test("files are checked: a name, base64, not empty, and the count and total size", () => {
	assert.doesNotThrow(() => checkFiles([{ name: "build.log", data: b64("failed") }]));
	assert.throws(() => checkFiles([{ name: " ", data: b64("x") }]), /needs a name/);
	assert.throws(() => checkFiles([{ name: "a", data: "not base64!" }]), /isn't base64/);
	assert.throws(() => checkFiles([{ name: "a", data: "" }]), /is empty/);
	assert.throws(() => checkFiles(Array.from({ length: 21 }, () => ({ name: "a", data: b64("x") }))), /at most 20 files/);
	assert.throws(() => checkFiles([{ name: "big.bin", data: Buffer.alloc(25 * 1024 * 1024 + 1).toString("base64") }]), /25\.0 MB; the limit is 25 MB/);
});

test("a file's name is made safe, keeping its extension, and saved files are told to the agent", async (t) => {
	assert.equal(safeName("../../etc/passwd"), "passwd");
	assert.equal(safeName("C:\\Users\\me\\Q3 Report (final).PDF"), "Q3-Report-final.pdf");
	assert.equal(safeName(".hidden"), "file.hidden");
	assert.equal(safeName("..."), "file");
	const uploads = tempDir(t);
	const saved = await saveFiles(uploads, 7, [{ name: "build.log", mimeType: "text/plain", data: b64("error: no") }, { name: "build.log", data: b64("again") }], undefined, new Date("2026-10-30T12:00:00Z"));
	assert.deepEqual(saved.map((s) => s.path.slice(uploads.length)), ["/7/20261030-120000-build.log", "/7/20261030-120000-2-build.log"]);
	assert.equal(readFileSync(saved[0]!.path, "utf8"), "error: no");
	const [note] = fileBlocks(saved);
	assert.match(note!.text, /<file name="build\.log" type="text\/plain" bytes="9" path="[^"]+build\.log" until="2026-11-13">\nThe user attached a file \(9 bytes\)/);
	assert.equal(withoutFileNotes(`Look at this${note!.text}`), "Look at this");
});

test("long text is long past 32 KB, and its preview keeps the start up to a line break", () => {
	assert.equal(isLong("x".repeat(PASTE_BYTES)), false);
	assert.equal(isLong("é".repeat(PASTE_BYTES / 2 + 1)), true, "bytes, not characters");
	const text = "line of the log\n".repeat(200);
	const shown = preview(text);
	assert.ok(shown.length <= 1502 && shown.endsWith("\n…"), String(shown.length));
	assert.ok(text.startsWith(shown.slice(0, -2)));
});

test("a long message is saved to a file the message points at, once, and the title and model see the start", async (t) => {
	const seen: string[] = [];
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	faux.setResponses(Array.from({ length: 5 }, () => (ctx: TranscriptContext) => {
		const last = ctx.messages.at(-1)!;
		seen.push(last.role === "user" ? textOf(last.content) : "");
		return fauxAssistantMessage(fauxText("Read it."));
	}));
	const models = createModels();
	models.setProvider(faux.provider);
	const titled: string[] = [];
	const titler = async (text: string) => {
		titled.push(text);
		return undefined;
	};
	const { host, dir } = await testHost(t, { models, model: { provider: "faux", modelId: "faux-1" }, titler });
	const project = makeProject(dir, "demo");
	const log = `Why does this fail?\n${"2026-10-30 ERROR something broke\n".repeat(2000)}`;
	const session = await host.sessions.create(project, "Why does this fail?");
	await (await host.submit(session.id, log, { requestId: "long-1" })).wait(context);

	const path = /path="([^"]+message\.txt)"/.exec(seen[0]!)?.[1];
	assert.ok(path !== undefined, seen[0]!.slice(0, 300));
	assert.equal(readFileSync(path, "utf8"), log, "the whole text is in the file");
	assert.ok(seen[0]!.startsWith("Why does this fail?\n2026-10-30 ERROR"));
	assert.ok(seen[0]!.length < 3000, String(seen[0]!.length));
	assert.match(seen[0]!, /too long to send whole \(\d+\.\d KB\)/);
	assert.ok(!titled[0]!.includes("<file"), "the title writer doesn't see the note");

	// A retry with the same request id saves nothing again.
	await host.submit(session.id, log, { requestId: "long-1" });
	assert.equal(readdirSync(dirname(path)).length, 1);
	// Short text is left alone.
	await (await host.submit(session.id, "and this?")).wait(context);
	assert.equal(seen.at(-1), "and this?");
	assert.equal(join(dirname(path), ".."), join(dir, "data", "uploads"));
});
