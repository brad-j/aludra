import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { restoreTree, snapshot } from "../src/changes.ts";
import { answeredMessage, RestoreRefused, restoreNoteText } from "../src/checkpoints.ts";
import { context } from "../src/host.ts";
import { makeProject, tempDir, testHost } from "./helpers.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" });

function repo(dir: string, files: Record<string, string>) {
	git(dir, "init", "-q", "-b", "main");
	for (const [file, text] of Object.entries(files)) {
		mkdirSync(join(dir, file, ".."), { recursive: true });
		writeFileSync(join(dir, file), text);
	}
	git(dir, "add", "-A");
	git(dir, "commit", "-qm", "start");
}

test("restoring a tree writes back changed and deleted files, removes new ones, and leaves ignored files, the index and other directories alone", async (t) => {
	const root = tempDir(t);
	repo(root, { ".gitignore": "build/\n", "Projects/one/a.txt": "a\n", "Projects/one/gone.txt": "gone\n", "Notes/n.md": "note\n" });
	const project = join(root, "Projects", "one");
	const before = await snapshot(project);
	assert.ok(!("error" in before));
	const index = readFileSync(join(root, ".git", "index"));

	writeFileSync(join(project, "a.txt"), "changed\n");
	execFileSync("rm", [join(project, "gone.txt")]);
	writeFileSync(join(project, "new.txt"), "new\n");
	mkdirSync(join(root, "build"));
	writeFileSync(join(root, "build", "out.js"), "ignored");
	writeFileSync(join(root, "Notes", "n.md"), "edited elsewhere\n");

	assert.deepEqual(await restoreTree(before, before.tree), { written: 2, deleted: 1 });
	assert.equal(readFileSync(join(project, "a.txt"), "utf8"), "a\n");
	assert.equal(readFileSync(join(project, "gone.txt"), "utf8"), "gone\n");
	assert.equal(existsSync(join(project, "new.txt")), false);
	assert.equal(readFileSync(join(root, "build", "out.js"), "utf8"), "ignored");
	assert.equal(readFileSync(join(root, "Notes", "n.md"), "utf8"), "edited elsewhere\n", "outside the project is untouched");
	assert.deepEqual(readFileSync(join(root, ".git", "index")), index, "the real index is untouched");
});

test("a request answers a user message only when its messages end with one", () => {
	assert.equal(answeredMessage([{ role: "user", content: "hi", timestamp: 5 }]), 5);
	assert.equal(answeredMessage([{ role: "user", content: "hi", timestamp: 5 }, { role: "toolResult", toolCallId: "1", toolName: "bash", content: [], isError: false, timestamp: 6 }]), undefined);
	assert.equal(answeredMessage([]), undefined);
	assert.match(restoreNoteText({ checkpoint: 2, written: 1, deleted: 1, files: ["a.txt", "b.txt"] }), /checkpoint="2".*1 written, 1 deleted\): a\.txt, b\.txt\. Read a file again/);
});

test("each turn gets a checkpoint, a turn's changes are its own, and a restore puts the files back, can be undone, and is told to the agent", async (t) => {
	const lastUser = (ctx: TranscriptContext) => JSON.stringify(ctx.messages.findLast((m) => m.role === "user")?.content ?? "");
	const told: string[] = [];
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	faux.setResponses(Array.from({ length: 20 }, () => (ctx: TranscriptContext) => {
		const last = ctx.messages.at(-1)!;
		if (last.role === "toolResult") return fauxAssistantMessage(fauxText("Done."));
		told.push(lastUser(ctx));
		if (/first/.test(lastUser(ctx))) return fauxAssistantMessage(fauxToolCall("bash", { command: "printf 'one\\n' > a.txt" }), { stopReason: "toolUse" });
		if (/second/.test(lastUser(ctx))) return fauxAssistantMessage(fauxToolCall("bash", { command: "printf 'new\\n' > b.txt" }), { stopReason: "toolUse" });
		if (/slow/.test(lastUser(ctx))) return fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 1" }), { stopReason: "toolUse" });
		return fauxAssistantMessage(fauxText("Ok."));
	}));
	const models = createModels();
	models.setProvider(faux.provider);
	const { host, dir } = await testHost(t, { models, model: { provider: "faux", modelId: "faux-1" } });
	const project = makeProject(dir, "demo", { "a.txt": "start\n" });
	repo(project.dir, {});

	const session = await host.sessions.create(project, "first");
	await (await host.submit(session.id, "first")).wait(context);
	await (await host.submit(session.id, "second")).wait(context);

	const checkpoints = await host.checkpoints.list(session.id);
	assert.deepEqual(checkpoints.map((c) => [c.id, c.kind]), [[1, "turn"], [2, "turn"]], "one per user message, none for tool results");
	const first = await host.checkpoints.changes(session.id, 1);
	const second = await host.checkpoints.changes(session.id, 2);
	assert.ok(first.available && second.available);
	assert.deepEqual(first.files.map((f) => [f.path, f.status]), [["a.txt", "modified"]]);
	assert.deepEqual(second.files.map((f) => [f.path, f.status]), [["b.txt", "added"]]);
	assert.match(await host.checkpoints.diff(session.id, 1, "a.txt"), /^-start$[\s\S]*^\+one$/m);
	await assert.rejects(host.checkpoints.diff(session.id, 1, "b.txt"), /no file b\.txt/);

	const restored = await host.checkpoints.restore(session.id, 1);
	assert.deepEqual([restored.written, restored.deleted, restored.undo], [1, 1, 3]);
	assert.deepEqual(restored.files.sort(), ["a.txt", "b.txt"]);
	assert.equal(readFileSync(join(project.dir, "a.txt"), "utf8"), "start\n");
	assert.equal(existsSync(join(project.dir, "b.txt")), false);
	assert.deepEqual((await host.checkpoints.list(session.id)).at(-1), { ...(await host.checkpoints.list(session.id)).at(-1)!, id: 3, kind: "restore", restored: 1 });

	// The undo is a restore of the checkpoint taken just before.
	await host.checkpoints.restore(session.id, 3);
	assert.equal(readFileSync(join(project.dir, "a.txt"), "utf8"), "one\n");
	assert.equal(readFileSync(join(project.dir, "b.txt"), "utf8"), "new\n");

	// The next message tells the agent, once.
	await (await host.submit(session.id, "carry on")).wait(context);
	assert.match(told.at(-1)!, /<restored checkpoint=\\"3\\">/);
	await (await host.submit(session.id, "and again")).wait(context);
	assert.doesNotMatch(told.at(-1)!, /restored/);

	// Refused while it runs.
	const running = await host.submit(session.id, "slow");
	while ((await host.sessions.states()).get(session.id) === "idle") await new Promise((resolve) => setTimeout(resolve, 10));
	await assert.rejects(host.checkpoints.restore(session.id, 1), RestoreRefused);
	await running.wait(context);
});

test("a no-project session and a project outside git have no checkpoints", async (t) => {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	faux.setResponses([fauxAssistantMessage(fauxText("Ok.")), fauxAssistantMessage(fauxText("Ok."))]);
	const models = createModels();
	models.setProvider(faux.provider);
	const { host, dir } = await testHost(t, { models, model: { provider: "faux", modelId: "faux-1" } });
	const plain = await host.sessions.create(makeProject(dir, "plain"), "hi");
	await (await host.submit(plain.id, "hi")).wait(context);
	assert.deepEqual(await host.checkpoints.list(plain.id), []);
	await assert.rejects(host.checkpoints.restore(plain.id, 1), RestoreRefused);
	const scratch = await host.sessions.createScratch("hi");
	await (await host.submit(scratch.id, "hi")).wait(context);
	assert.deepEqual(await host.checkpoints.list(scratch.id), []);
});
