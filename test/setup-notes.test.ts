// The user's setup notes (src/setup-notes.ts): files in a directory, a map in no-project sessions' prompts and
// read_setup for a topic, never anything compiled in.
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { configFor } from "../src/config.ts";
import { MAP_MAX, setupExtension, setupSection, setupTopics } from "../src/setup-notes.ts";
import { makeProject, tempDir, testHost } from "./helpers.ts";

type Run = { output: { text: string }[]; isError?: boolean };
const readSetup = (dir: string) => {
	const tool = setupExtension({ dir: () => dir }).tools![0]!;
	return async (topic: string) => (await tool.execute({ topic } as never, {} as never, BACKGROUND_CONTEXT)) as unknown as Run;
};

test("topics are the directory's .md files but README.md, plain files only, and read_setup returns one whole", async (t) => {
	const dir = tempDir(t);
	writeFileSync(join(dir, "README.md"), "Two machines: a workstation and a laptop.\n");
	writeFileSync(join(dir, "machines.md"), "The workstation runs the host.\n");
	writeFileSync(join(dir, "vms.md"), "None yet.\n");
	writeFileSync(join(dir, "notes.txt"), "not a topic");
	writeFileSync(join(dir, "Bad Name.md"), "not a topic either");
	writeFileSync(join(tempDir(t), "secret.md"), "outside");
	symlinkSync("/etc/hostname", join(dir, "linked.md"));
	mkdirSync(join(dir, "dir.md"));
	assert.deepEqual(setupTopics(dir), ["machines", "vms"]);
	const read = readSetup(dir);
	assert.deepEqual(await read("machines"), { output: [{ type: "text", text: "The workstation runs the host." }] });
	for (const topic of ["linked", "../secret", "README", "nope"]) {
		const refused = await read(topic);
		assert.equal(refused.isError, true, topic);
		assert.match(refused.output[0]!.text, /Topics: machines, vms\./);
	}
});

test("the section carries the map and the topics, cuts a long map, and is absent with no notes", (t) => {
	const dir = tempDir(t);
	assert.equal(setupSection(join(dir, "missing")), undefined);
	assert.equal(setupSection(dir), undefined);
	writeFileSync(join(dir, "machines.md"), "x");
	assert.match(setupSection(dir)!, /read_setup[\s\S]*Topics: machines\.$/);
	writeFileSync(join(dir, "README.md"), "m".repeat(MAP_MAX + 50));
	const section = setupSection(dir)!;
	assert.ok(section.includes("m".repeat(MAP_MAX)));
	assert.ok(!section.includes("m".repeat(MAP_MAX + 1)));
	assert.match(section, /The rest of the map is cut/);
	assert.equal(setupSection(join(dir, "empty-dir")), undefined);
});

test("setup.dir defaults to setup/ in the data directory, and the settings can name another", () => {
	const plain = configFor(JSON.stringify({ dataDir: "/data" })).config;
	assert.equal(plain.setup.dir, "/data/setup");
	assert.equal(configFor(JSON.stringify({ dataDir: "/data", setup: { dir: "/notes/setup" } })).config.setup.dir, "/notes/setup");
});

test("only no-project sessions on this machine get the map and read_setup", async (t) => {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	const seen = new Map<string, { tools: string[]; map: boolean }>();
	faux.setResponses(Array.from({ length: 10 }, () => (ctx: TranscriptContext) => {
		const system = ctx.messages.filter((m) => m.role === "system") as unknown as { toolsAdded?: { name: string }[] }[];
		const tools = system.flatMap((m) => (m.toolsAdded ?? []).map((tool) => tool.name));
		const user = JSON.stringify(ctx.messages.findLast((m) => m.role === "user")?.content ?? "");
		seen.set(/which (\w+)/.exec(user)?.[1] ?? "?", { tools, map: JSON.stringify(system).includes("A workstation and a laptop") });
		if (/read it/.test(user) && ctx.messages.at(-1)?.role !== "toolResult") return fauxAssistantMessage(fauxToolCall("read_setup", { topic: "machines" }), { stopReason: "toolUse" });
		return fauxAssistantMessage(fauxText("ok"));
	}));
	const models = createModels();
	models.setProvider(faux.provider);
	const { host, dir, config } = await testHost(t, { models, model: { provider: "faux", modelId: "faux-1" } });
	mkdirSync(config.setup.dir, { recursive: true });
	writeFileSync(join(config.setup.dir, "README.md"), "A workstation and a laptop.");
	writeFileSync(join(config.setup.dir, "machines.md"), "The workstation runs the host.");
	const project = makeProject(dir, "demo");
	const ask = async (id: number, text: string) => (await host.submit(id, text)).wait(BACKGROUND_CONTEXT);
	await ask((await host.sessions.createScratch("x")).id, "which scratch, read it");
	await ask((await host.sessions.createChat(undefined, "x")).id, "which chat");
	await ask((await host.sessions.create(project, "x")).id, "which project");
	await ask((await host.sessions.createChat(project, "x")).id, "which projectchat");
	assert.ok(seen.get("scratch")!.tools.includes("read_setup") && seen.get("scratch")!.map);
	assert.ok(seen.get("chat")!.tools.includes("read_setup") && seen.get("chat")!.map);
	for (const kind of ["project", "projectchat"]) {
		assert.ok(!seen.get(kind)!.tools.includes("read_setup"), kind);
		assert.equal(seen.get(kind)!.map, false, kind);
	}
});
