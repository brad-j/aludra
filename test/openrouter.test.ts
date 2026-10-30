import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import type { ConversationView } from "@earendil-works/pi-durable";
import { AgentDoc } from "@earendil-works/pi-durable";
import type { SessionSummary } from "../src/api-types.ts";
import { createCatalog } from "../src/catalog.ts";
import { configFor } from "../src/config.ts";
import { credentialsFile, fileCredentialStore } from "../src/credentials.ts";
import { context, conversationId, openHost } from "../src/host.ts";
import { money, renderSessions } from "../src/listing.ts";
import { billedCost, spendOf } from "../src/transcript.ts";
import { fakeClaudeCode, makeProject, tempDir } from "./helpers.ts";

test("OpenRouter's models are offered once signed in, each with its price", async (t) => {
	const saved = process.env.OPENROUTER_API_KEY;
	delete process.env.OPENROUTER_API_KEY;
	t.after(() => (saved === undefined ? undefined : (process.env.OPENROUTER_API_KEY = saved)));
	const store = fileCredentialStore(credentialsFile(tempDir(t)));
	const models = createModels({ credentials: store });
	models.setProvider(openrouterProvider());
	const catalog = createCatalog(models);
	assert.deepEqual(await catalog.list(), [], "not signed in");

	await store.modify("openrouter", async () => ({ type: "oauth", access: "sk-or-test", refresh: "", expires: Number.MAX_SAFE_INTEGER }));
	const offered = await catalog.list();
	assert.ok(offered.length > 100, `${offered.length} models`);
	const opus = offered.find((m) => m.id === "anthropic/claude-opus-5.5");
	assert.deepEqual(opus?.price, { input: 4, output: 20 });
	assert.equal(opus?.provider, "openrouter");
});

test("a session can run on any model a provider has, named provider/id, pinned or not", async (t) => {
	const dir = tempDir(t);
	const { config, errors } = configFor(JSON.stringify({
		dataDir: join(dir, "data"),
		workspaces: [{ name: "test", roots: [join(dir, "Projects", "*", "*")] }],
		model: { choices: ["claude-opus-5-5", "openrouter/~deepseek/deepseek-flash-latest"] },
	}), {});
	assert.deepEqual(errors, []);
	assert.deepEqual(config.model.choices.at(-1), { provider: "openrouter", id: "~deepseek/deepseek-flash-latest" });
	const host = await openHost({ config, claudeCode: fakeClaudeCode([]).claudeCode, agentDir: join(dir, "agent") });
	t.after(() => host.close());
	const project = makeProject(dir, "demo");
	const agentOf = async (id: number) => (await host.harness.snapshot(AgentDoc, conversationId(id), context))?.model;

	assert.deepEqual(host.choices().at(-1)?.price !== undefined, true, "a pinned OpenRouter model has its price");
	const session = await host.sessions.create(project, "hi", { model: "openrouter/anthropic/claude-sonnet-5.5" });
	assert.deepEqual(await agentOf(session.id), { provider: "openrouter", modelId: "anthropic/claude-sonnet-5.5" });
	await host.configure(session.id, { model: "claude-opus-5-5" });
	assert.deepEqual(await agentOf(session.id), { provider: "claude-bridge", modelId: "claude-opus-5-5" });
	await assert.rejects(host.configure(session.id, { model: "openrouter/no/such-model" }), /no model/);
	assert.equal(host.hasModel("openrouter", "anthropic/claude-sonnet-5.5"), true);
});

const answer = (provider: string, cost: number, timestamp: number) =>
	({ role: "assistant", provider, model: "m", api: "x", content: [], stopReason: "stop", timestamp, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } } }) as unknown as AssistantMessage;

test("a session's spend adds up billed answers only, from a given time on", () => {
	const view = { entries: [{ model: [answer("claude-bridge", 3, 1)] }, { model: [answer("openrouter", 0.25, 10)] }, { model: [answer("openrouter", 0.5, 20)] }] } as unknown as ConversationView;
	assert.equal(spendOf(view), 0.75);
	assert.equal(spendOf(view, 15), 0.5);
	assert.equal(spendOf({ entries: [{ model: [answer("claude-bridge", 3, 1)] }] } as unknown as ConversationView), undefined, "nothing billed");
	assert.deepEqual([money(0), money(0.001), money(0.4), money(12.3), money(140.4)], ["$0", "<$0.01", "$0.40", "$12.30", "$140"]);
});

test("a session's charged cost comes from its usage ledger, billed providers only", () => {
	const used = (total: number) => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total } });
	assert.equal(billedCost({ models: { "openrouter/anthropic/claude-opus-5.5": used(0.3), "openrouter/~deepseek/deepseek-flash-latest": used(0.02), "claude-bridge/claude-opus-5-5": used(2), "openai/gpt-6.1-sol": used(1) } }), 0.32);
	assert.equal(billedCost({ models: { "openai/gpt-6.1-sol": used(1) } }), undefined, "ChatGPT is on the plan");
	assert.equal(billedCost(undefined), undefined);
});

test("aludra sessions shows a billed session's cost and the month's total", () => {
	const now = Date.UTC(2026, 9, 13, 12);
	const s = (id: number, cost?: number): SessionSummary => ({ id, workspace: "w", project: "p", dir: "/w/p", title: `s${id}`, createdAt: now, updatedAt: now, state: "done", line: "", ...(cost === undefined ? {} : { cost }) });
	const lines = renderSessions([s(1, 0.42), s(2)], {}, { depth: 1, width: 60 }, now, { month: 3.2 });
	assert.match(lines.find((l) => l.includes("s1"))!, /s1 +\$0\.42  now$/);
	assert.match(lines.find((l) => l.includes("s2"))!, /s2 +now$/);
	assert.equal(lines.at(-1), "OpenRouter this month: $3.20");
	assert.equal(renderSessions([s(2)], {}, { depth: 1, width: 60 }, now).some((l) => l.includes("OpenRouter")), false);
});
