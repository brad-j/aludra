import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { AgentDoc } from "@earendil-works/pi-durable";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { createApi } from "../src/api.ts";
import { context, conversationId } from "../src/host.ts";
import { Subagents } from "../src/subagents.ts";
import { makeProject, testHost } from "./helpers.ts";

const lastUser = (ctx: TranscriptContext) => JSON.stringify(ctx.messages.findLast((m) => m.role === "user")?.content ?? "");
const system = (ctx: TranscriptContext) => JSON.stringify(ctx.messages.filter((m) => m.role === "system"));

/**
 * The parent on faux-1 calls agent once, or twice at once for "two"; "nested" has the child try agent itself, "push" has
 * it run git push. The child on faux-2 runs pwd and writes found.txt, then answers with what pwd said.
 */
function models() {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }, { id: "faux-2" }] });
	const seen: { model: string; system: string; user: string }[] = [];
	faux.setResponses(Array.from({ length: 100 }, () => (ctx: TranscriptContext, _options: unknown, _state: unknown, model: { id: string }) => {
		const user = lastUser(ctx);
		seen.push({ model: model.id, system: system(ctx), user });
		const last = ctx.messages.at(-1);
		if (model.id === "faux-1") {
			if (last?.role === "toolResult") return fauxAssistantMessage(fauxText(`Parent got: ${JSON.stringify(ctx.messages.filter((m) => m.role === "toolResult").map((m) => m.content))}`));
			if (/two/.test(user)) return fauxAssistantMessage([fauxToolCall("agent", { title: "Look A", task: "find A" }), fauxToolCall("agent", { title: "Look B", task: "find B" })], { stopReason: "toolUse" });
			const task = /nested/.test(user) ? "nested" : /push/.test(user) ? "push" : "where are you";
			return fauxAssistantMessage(fauxToolCall("agent", { title: "Find the directory", task }), { stopReason: "toolUse" });
		}
		if (last?.role === "toolResult") return fauxAssistantMessage(fauxText(`Child saw ${JSON.stringify(last.content)}`));
		if (/nested/.test(user)) return fauxAssistantMessage(fauxToolCall("agent", { title: "Deeper", task: "more" }), { stopReason: "toolUse" });
		if (/push/.test(user)) return fauxAssistantMessage(fauxToolCall("bash", { command: "echo pushing; git push --dry-run 2>&1 || true" }), { stopReason: "toolUse" });
		return fauxAssistantMessage(fauxToolCall("bash", { command: `echo found > found-${user.includes("B") ? "b" : "a"}.txt; pwd` }), { stopReason: "toolUse" });
	}));
	const catalog = createModels();
	catalog.setProvider(faux.provider);
	return { models: catalog, model: { provider: "faux", modelId: "faux-1" }, seen };
}

async function children(host: Awaited<ReturnType<typeof testHost>>["host"]) {
	return Object.entries((await host.harness.snapshot(Subagents, context))?.children ?? {}).map(([id, child]) => ({ id: Number(id), ...child }));
}

test("the agent tool runs a child on the subagent model in the session's directory and returns its answer", async (t) => {
	const { models: catalog, model, seen } = models();
	const { host, dir } = await testHost(t, { models: catalog, model, settings: { subagents: { model: "faux/faux-2" } } });
	const project = makeProject(dir, "one");
	const session = await host.sessions.create(project, "look around");
	assert.equal((await (await host.submit(session.id, "look around")).wait(context)).status, "done");

	const [child] = await children(host);
	assert.ok(child !== undefined);
	assert.equal(child.session, session.id);
	assert.equal(child.title, "Find the directory");
	// The child ran on faux-2, in the session's project, and was told it's a subagent; the parent wasn't.
	const childRequests = seen.filter((s) => s.model === "faux-2");
	assert.ok(childRequests.length >= 2);
	assert.match(childRequests[0]!.system, /You're a subagent/);
	assert.doesNotMatch(seen.find((s) => s.model === "faux-1")!.system, /You're a subagent/);
	assert.match(childRequests[0]!.system, /"name":"bash"/);
	assert.doesNotMatch(childRequests[0]!.system, /"name":"agent"/, "a child can't start children");
	assert.doesNotMatch(childRequests[0]!.system, /"name":"publish_page"/);
	assert.match(seen.find((s) => s.model === "faux-1")!.system, /"name":"agent"/);
	assert.equal(readFileSync(join(project.dir, "found-a.txt"), "utf8"), "found\n");
	assert.equal((await host.harness.snapshot(AgentDoc, conversationId(child.id), context))?.model?.modelId, "faux-2");

	// The parent read the child's last answer as the call's output, and the call's details name the child.
	const view = await (await host.conversation(session.id)).viewState(context);
	const result = view.value.entries.flatMap((e) => e.model ?? []).find((m) => m.role === "toolResult" && m.toolName === "agent");
	view.dispose();
	const output = (result as { content: { text: string }[] }).content[0]!.text;
	assert.ok(output.startsWith("Child saw") && output.includes(project.dir), output);
	assert.deepEqual((result as { details?: unknown }).details, { conversationId: child.id, title: "Find the directory", model: "faux/faux-2", status: "done" });

	// Children aren't sessions: not listed, and not opened as one.
	assert.deepEqual((await host.sessions.list()).map((s) => s.id), [session.id]);
	assert.equal(await host.sessions.get(child.id), undefined);
	assert.equal((await host.subagent(child.id))?.session, session.id);
	assert.equal(await host.subagent(session.id), undefined);
	assert.equal((await host.sessions.states()).get(session.id), "idle");
});

test("two calls in one turn run two children, and a child can't start its own", async (t) => {
	const { models: catalog, model } = models();
	const { host, dir } = await testHost(t, { models: catalog, model, settings: { subagents: { model: "faux/faux-2" } } });
	const project = makeProject(dir, "one");
	const session = await host.sessions.create(project, "two");
	await (await host.submit(session.id, "two")).wait(context);
	assert.deepEqual((await children(host)).map((c) => c.title).sort(), ["Look A", "Look B"]);
	assert.equal(readFileSync(join(project.dir, "found-b.txt"), "utf8"), "found\n");

	const nested = await host.sessions.create(project, "nested");
	await (await host.submit(nested.id, "nested")).wait(context);
	const mine = (await children(host)).filter((c) => c.session === nested.id);
	assert.equal(mine.length, 1, "the child's own agent call made nothing");
	const view = await (await host.harness.conversation(conversationId(mine[0]!.id), context))!.viewState(context);
	const text = JSON.stringify(view.value.entries.flatMap((e) => e.model ?? []).filter((m) => m.role === "toolResult"));
	view.dispose();
	assert.match(text, /Tool agent is not available/, "it has no agent tool");
});

test("without the subagent model on this host, children run on the session's model", async (t) => {
	const { models: catalog, model, seen } = models();
	const { host, dir } = await testHost(t, { models: catalog, model });
	const session = await host.sessions.create(makeProject(dir, "one"), "look");
	await (await host.submit(session.id, "look")).wait(context);
	assert.equal(seen.filter((s) => s.model === "faux-2").length, 0);
	assert.ok(seen.filter((s) => /You're a subagent/.test(s.system)).every((s) => s.model === "faux-1"));
	assert.equal((await children(host)).length, 1);
});

test("a child's git push waits for approval as its session's, and stopping the session stops the child", async (t) => {
	const { models: catalog, model } = models();
	const { host, dir } = await testHost(t, { models: catalog, model, settings: { subagents: { model: "faux/faux-2" } } });
	const session = await host.sessions.create(makeProject(dir, "one"), "push");
	const run = await host.submit(session.id, "push");
	let request;
	for (;;) {
		request = (await host.approvals.pending())[0];
		if (request !== undefined) break;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	assert.equal(request.conversationId, session.id, "asked as the session");
	assert.equal(request.summary, "git push");
	assert.equal((await host.sessions.states()).get(session.id), "waiting");
	await host.stop(session.id);
	await run.wait(context);
	const [child] = await children(host);
	assert.equal((await host.sessions.states()).get(session.id), "idle");
	assert.equal((await host.approvals.pending()).length, 0);
	assert.ok(child !== undefined);
});

test("/amyrlin opens a child with conversation.watch and conversation.history, its session as parent; other methods don't", async (t) => {
	const { models: catalog, model } = models();
	const { host, dir } = await testHost(t, { models: catalog, model, settings: { subagents: { model: "faux/faux-2" } } });
	const session = await host.sessions.create(makeProject(dir, "one"), "look");
	await (await host.submit(session.id, "look")).wait(context);
	const [child] = await children(host);
	const server = createApi(host, { users: ["you@example.com"], name: "test-host" });
	await new Promise<void>((resolve) => server.listen(0, resolve));
	t.after(() => server.close());
	const ws = new WebSocket(`ws://127.0.0.1:${(server.server.address() as AddressInfo).port}/amyrlin`, { headers: { "tailscale-user-login": "you@example.com" } });
	t.after(() => ws.close());
	const frames: { type: string; id?: string; result?: Record<string, unknown>; error?: { code: string }; events?: { type: string; conversation?: Record<string, unknown>; items?: unknown[] }[] }[] = [];
	ws.on("message", (data) => frames.push(JSON.parse(String(data))));
	await new Promise((resolve) => ws.once("open", resolve));
	const until = async <T>(find: () => T | undefined) => {
		for (let i = 0; i < 250; i++) {
			const found = find();
			if (found !== undefined) return found;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		throw new Error("timed out");
	};
	ws.send(JSON.stringify({ type: "hello", protocols: [1], client: { name: "test", version: "0" } }));
	await until(() => frames.find((f) => f.type === "welcome"));
	let next = 0;
	const request = async (method: string, params: Record<string, unknown>) => {
		const id = `r${++next}`;
		ws.send(JSON.stringify({ type: "request", id, method, params }));
		return until(() => frames.find((f) => f.type === "response" && f.id === id));
	};

	assert.equal((await request("host.info", {})).result?.subagents, true);
	const watched = await request("conversation.watch", { conversationId: child!.id });
	assert.ok(watched.result?.subscription);
	const snapshot = await until(() => frames.flatMap((f) => f.events ?? []).find((e) => e.type === "snapshot"));
	assert.deepEqual({ ...snapshot.conversation, dir: undefined }, { id: child!.id, title: "Find the directory", archived: false, parent: session.id, project: "one", dir: undefined });
	assert.ok((snapshot.items ?? []).length > 0);
	const history = (await request("conversation.history", { conversationId: child!.id })).result;
	assert.ok((history?.items as unknown[] | undefined ?? []).length > 0);
	assert.equal((await request("conversations.rename", { conversationId: child!.id, title: "x" })).error?.code, "not_found");
	const list = (await request("conversations.list", {})).result?.conversations as { id: number }[];
	assert.deepEqual(list.map((c) => c.id), [session.id]);
});
