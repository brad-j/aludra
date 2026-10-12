import assert from "node:assert/strict";
import test from "node:test";
import { type Message, normalizeContext, type TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { bridgeProvider, RECOVERY_NOTE } from "../src/bridge.ts";
import { context } from "../src/host.ts";
import { fakeBridge, makeProject, testHost } from "./helpers.ts";

const user = (text: string, timestamp = 1): Message => ({ role: "user", content: [{ type: "text", text }], timestamp });
const toolUse = () => fauxAssistantMessage(fauxToolCall("bash", { command: "ls" }, { id: "call-1" }), { stopReason: "toolUse" });
const toolResult = (timestamp = 3): Message => ({ role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text: "a.txt" }], isError: false, timestamp });
const transcript = (...messages: Message[]): TranscriptContext => normalizeContext({ messages });

test("a request's abort reaches the bridge only while its stream runs; abort() ends a session's query between requests", async () => {
	const { bridge, seen } = fakeBridge([toolUse(), fauxAssistantMessage("done"), fauxAssistantMessage("again")]);
	const { provider, abort } = bridgeProvider(bridge);
	const model = provider.getModels()[0]!;

	const first = new AbortController();
	await provider.streamSimple(model, transcript(user("hi")), { sessionId: "s1", signal: first.signal }).result();
	// Pi Durable aborts each request's signal once the request is done; the bridge's query must outlive that.
	first.abort();
	assert.equal(seen[0]!.options.signal?.aborted, false);

	const second = new AbortController();
	const running = provider.streamSimple(model, transcript(user("hi"), toolUse(), toolResult()), { sessionId: "s1", signal: second.signal });
	assert.equal(seen[1]!.options.signal, seen[0]!.options.signal, "one signal for the session's query");
	second.abort();
	await running.result();
	assert.equal(seen[1]!.options.signal?.aborted, true, "an abort while the stream runs is a real stop");

	await provider.streamSimple(model, transcript(user("next", 5)), { sessionId: "s1" }).result();
	assert.notEqual(seen[2]!.options.signal, seen[1]!.options.signal, "a stopped query's signal isn't reused");
	abort("s1");
	assert.equal(seen[2]!.options.signal?.aborted, true);
});

test("a tool result the bridge has no query for gets the recovery note; one it's waiting for doesn't", async () => {
	const { bridge, seen } = fakeBridge([fauxAssistantMessage("recovered"), toolUse(), fauxAssistantMessage("done")]);
	const { provider } = bridgeProvider(bridge);
	const model = provider.getModels()[0]!;

	// As after a restart: the transcript ends in a tool result and nothing in this process asked for it.
	await provider.streamSimple(model, transcript(user("hi"), toolUse(), toolResult()), { sessionId: "s1" }).result();
	assert.deepEqual(seen[0]!.context.messages.at(-1), { ...seen[0]!.context.messages.at(-1), role: "user", content: [{ type: "text", text: RECOVERY_NOTE }] });

	await provider.streamSimple(model, transcript(user("more", 5)), { sessionId: "s2" }).result();
	await provider.streamSimple(model, transcript(user("more", 5), toolUse(), toolResult(7)), { sessionId: "s2" }).result();
	assert.equal(seen[2]!.context.messages.at(-1)!.role, "toolResult");
});

test("a new head of the history (compaction, reset) tells the bridge to rebuild that session; summaries don't count", async () => {
	const { bridge, rewritten, seen } = fakeBridge(Array.from({ length: 5 }, () => fauxAssistantMessage("ok")));
	const { provider } = bridgeProvider(bridge);
	const model = provider.getModels()[0]!;
	const ask = (sessionId: string, ...messages: Message[]) => provider.streamSimple(model, transcript(...messages), { sessionId }).result();

	await ask("s1", user("hi", 1));
	await ask("s1", user("hi", 1), fauxAssistantMessage("ok"), user("more", 3));
	await provider.streamSimple(model, transcript(user("summarize this", 9)), { sessionId: "s1", cacheRetention: "none" }).result();
	assert.deepEqual(rewritten, []);
	await ask("s1", user("Summary: hi and more", 10), user("next", 11));
	assert.deepEqual(rewritten, ["s1"]);
	assert.equal(seen.length, 4);
});

test("each session's requests run in its project's directory, two at once, with its context recorded as the prompt", async (t) => {
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => (release = resolve));
	const answers = Array.from({ length: 4 }, () => async (ctx: TranscriptContext) => {
		if (ctx.messages.at(-1)?.role === "toolResult") return fauxAssistantMessage(fauxText(`ran: ${JSON.stringify(ctx.messages.at(-1)!.content)}`));
		await gate;
		return fauxAssistantMessage(fauxToolCall("bash", { command: "pwd" }), { stopReason: "toolUse" });
	});
	const { bridge, seen, prompts } = fakeBridge(answers);
	const { host, dir } = await testHost(t, { bridge });
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
	assert.ok(prompts.some((p) => p.includes("Project one's rule: tabs.")), "the project's AGENTS.md is in the recorded prompt");
});

test("after a compaction, the next request tells the bridge to rebuild the session", async (t) => {
	const { bridge, seen, rewritten } = fakeBridge(Array.from({ length: 10 }, () => (ctx: TranscriptContext) =>
		fauxAssistantMessage(/summar/i.test(JSON.stringify(ctx.messages.at(-1))) ? "Summary: notes about the backup." : "noted")));
	const { host, dir } = await testHost(t, { bridge });
	const session = await host.sessions.create(makeProject(dir, "one"), "notes");
	for (let n = 0; n < 3; n++) await (await host.submit(session.id, `note ${n}: ${"the backup failed again. ".repeat(3000)}`)).wait(context);
	assert.deepEqual(rewritten, []);

	const conversation = await host.conversation(session.id);
	const task = await conversation.compact(undefined, context);
	await host.harness.waitForTask(task, context);
	await conversation.waitForIdle(context);
	assert.ok(seen.some((s) => s.options.cacheRetention === "none"), "the summary went to the bridge as a one-off");

	await (await host.submit(session.id, "and now?")).wait(context);
	assert.equal(rewritten.length, 1);
	assert.equal(rewritten[0], seen.at(-1)!.options.sessionId);
});

test("stopping a session between requests ends its Claude Code query", async (t) => {
	const { bridge, seen } = fakeBridge([fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 10" }), { stopReason: "toolUse" })]);
	const { host, dir } = await testHost(t, { bridge });
	const session = await host.sessions.create(makeProject(dir, "one"), "sleepy");
	const run = await host.submit(session.id, "sleep");
	while ((await host.sessions.states()).get(session.id) !== "running" || seen.length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
	await new Promise((resolve) => setTimeout(resolve, 200));
	assert.equal(seen[0]!.options.signal?.aborted, false, "the query stays open while the tool runs");
	await host.stop(session.id);
	assert.equal(seen[0]!.options.signal?.aborted, true);
	assert.equal((await run.wait(context)).status, "unanswered");
});
