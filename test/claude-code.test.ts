import assert from "node:assert/strict";
import test from "node:test";
import type { Model, TranscriptContext } from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { claudeCodeProvider, PROVIDER } from "../src/claude-code.ts";
import { context } from "../src/host.ts";
import { fakeClaudeCode, makeProject, testHost } from "./helpers.ts";

test("its models run under aludra's provider ID, only the ones the account offers, without Claude Code's default alias", () => {
	const { faux } = fakeClaudeCode([]);
	const model = (id: string): Model<string> => ({ ...faux.models[0]!, id, name: id });
	const offered = new Set(["default", "claude-opus-5-5", "claude-sonnet-5-5"]);
	const inner: Provider = {
		...faux.provider,
		getModels: () => ["default", "claude-opus-5-5", "claude-sonnet-5", "claude-sonnet-5-5"].map(model),
		filterModels: (models) => models.filter((m) => offered.has(m.id)),
	};
	const { provider } = claudeCodeProvider(inner);
	assert.equal(provider.id, PROVIDER);
	assert.deepEqual(provider.getModels().map((m) => [m.provider, m.api, m.id]), [[PROVIDER, PROVIDER, "claude-opus-5-5"], [PROVIDER, PROVIDER, "claude-sonnet-5-5"]]);
});

test("each session's requests run in its project's directory, two at once, with its project context in the system prompt", async (t) => {
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => (release = resolve));
	const answers = Array.from({ length: 4 }, () => async (ctx: TranscriptContext) => {
		if (ctx.messages.at(-1)?.role === "toolResult") return fauxAssistantMessage(fauxText(`ran: ${JSON.stringify(ctx.messages.at(-1)!.content)}`));
		await gate;
		return fauxAssistantMessage(fauxToolCall("bash", { command: "pwd" }), { stopReason: "toolUse" });
	});
	const { claudeCode, seen } = fakeClaudeCode(answers);
	const { host, dir } = await testHost(t, { claudeCode });
	const one = makeProject(dir, "one", { "AGENTS.md": "Project one's rule: tabs." });
	const two = makeProject(dir, "two");
	const before = process.cwd();

	const a = await host.sessions.create(one, "first");
	const b = await host.sessions.create(two, "second");
	const runs = [await host.submit(a.id, "where?"), await host.submit(b.id, "where?")];
	await new Promise((resolve) => setTimeout(resolve, 100));
	release();
	const settled = await Promise.all(runs.map((run) => run.wait(context)));
	assert.deepEqual(settled.map((s) => s.status), ["done", "done"]);

	const bySession = Map.groupBy(seen, (s) => s.options.sessionId);
	assert.equal(bySession.size, 2);
	const dirs = [...bySession.values()].map((requests) => [...new Set(requests.map((r) => r.cwd))]);
	assert.deepEqual(dirs.sort(), [[one.dir], [two.dir]].sort());
	assert.equal(process.cwd(), before);
	const answer = async (id: number) => JSON.stringify((await (await host.conversation(id)).context(context)).messages.at(-1));
	assert.match(await answer(a.id), new RegExp(one.dir));
	assert.match(await answer(b.id), new RegExp(two.dir));
	const system = (requests: typeof seen) => JSON.stringify(requests[0]!.context.messages.filter((m) => m.role === "system"));
	const prompts = [...bySession.values()].map(system);
	assert.equal(prompts.filter((p) => p.includes("Project one's rule: tabs.")).length, 1, "only project one's prompt has its AGENTS.md");
});
