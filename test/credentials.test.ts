import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { Credential } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { AgentDoc } from "@earendil-works/pi-durable";
import { configFor } from "../src/config.ts";
import { credentialsFile, deviceId, fileCredentialStore } from "../src/credentials.ts";
import { context, conversationId, openHost } from "../src/host.ts";
import { fakeClaudeCode, makeProject, tempDir } from "./helpers.ts";

const oauth = (access: string): Credential => ({ type: "oauth", access, refresh: "r", expires: Date.now() + 3_600_000 });

test("sign-ins are kept owner-only, read afresh, and written one at a time", async (t) => {
	const dir = tempDir(t);
	const file = credentialsFile(join(dir, "data"));
	const store = fileCredentialStore(file);
	assert.equal(await store.read("openai"), undefined);

	await store.modify("openai", async () => oauth("a"));
	assert.equal(statSync(file).mode & 0o777, 0o600);
	assert.deepEqual(await store.list(), [{ providerId: "openai", type: "oauth" }]);

	// Another process (the CLI signing in again) writes the file; the next read sees it.
	await fileCredentialStore(file).modify("openai", async () => oauth("b"));
	assert.equal(((await store.read("openai")) as { access: string }).access, "b");

	// Writes wait their turn: each sees the one before.
	const order: string[] = [];
	await Promise.all(["c", "d", "e"].map((access) => store.modify("openai", async (current) => {
		order.push(`${(current as { access: string }).access}→${access}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
		return oauth(access);
	})));
	assert.deepEqual(order, ["b→c", "c→d", "d→e"]);

	// A lock left by a process that died is taken over once it's stale.
	writeFileSync(`${file}.lock`, "");
	const old = new Date(Date.now() - 600_000);
	utimesSync(`${file}.lock`, old, old);
	await store.delete("openai");
	assert.equal(await store.read("openai"), undefined);
	assert.equal(existsSync(`${file}.lock`), false);
});

test("pi-ai reads a stored ChatGPT sign-in as OAuth, and the installation ID stays the same", async (t) => {
	const dir = tempDir(t);
	const store = fileCredentialStore(credentialsFile(dir));
	const models = createModels({ credentials: store });
	models.setProvider(openaiProvider());
	await store.modify("openai", async () => oauth("token"));
	assert.equal((await models.checkAuth("openai"))?.type, "oauth");

	const id = deviceId(dir);
	assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	assert.equal(deviceId(dir), id);
	assert.equal(readFileSync(join(dir, "device-id"), "utf8").trim(), id);
});

test("the apps offer Claude and OpenAI models side by side, and a session can start on either", async (t) => {
	const dir = tempDir(t);
	const { config, errors } = configFor(JSON.stringify({
		dataDir: join(dir, "data"),
		workspaces: [{ name: "test", roots: [join(dir, "Projects", "*", "*")] }],
		model: { choices: ["claude-opus-5-5", "openai/gpt-6.1-sol", "openai/no-such-model"] },
	}), {});
	assert.deepEqual(errors, []);
	const host = await openHost({ config, claudeCode: fakeClaudeCode([]).claudeCode, agentDir: join(dir, "agent") });
	t.after(() => host.close());

	// One OpenAI doesn't have is left out, as Claude Code's are.
	assert.deepEqual(host.choices().map((c) => [c.provider, c.id, c.name]), [["claude-bridge", "claude-opus-5-5", "claude-opus-5-5"], ["openai", "gpt-6.1-sol", "GPT-6.1 Sol"]]);
	assert.equal(host.modelInfo({ provider: "openai", modelId: "gpt-6.1-sol" }).window, 272_000);

	const project = makeProject(dir, "demo");
	const agentOf = async (id: number) => (await host.harness.snapshot(AgentDoc, conversationId(id), context))?.model;
	const gpt = await host.sessions.create(project, "hi", { model: "gpt-6.1-sol" });
	assert.deepEqual(await agentOf(gpt.id), { provider: "openai", modelId: "gpt-6.1-sol" });
	const claude = await host.sessions.create(project, "hi");
	assert.deepEqual(await agentOf(claude.id), { provider: "claude-bridge", modelId: "claude-opus-5-5" });

	// Switching a session to the other provider applies from its next request.
	await host.configure(claude.id, { model: "gpt-6.1-sol" });
	assert.deepEqual(await agentOf(claude.id), { provider: "openai", modelId: "gpt-6.1-sol" });
});
