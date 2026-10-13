import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { WebSocket } from "ws";
import { createApi } from "../src/api.ts";
import { type Json, translateFixture } from "../src/amyrlin/translate.ts";
import { makeProject, testHost } from "./helpers.ts";

const USER = "you@example.com";
const FIXTURES = join(import.meta.dirname, "fixtures", "amyrlin");

test("the translation matches amyrlin's expected frames for every recorded scenario", () => {
	const names = readdirSync(join(FIXTURES, "durable-1.1.0")).filter((f) => f.endsWith(".jsonl"));
	assert.equal(names.length, 18);
	for (const name of names) {
		const frames = translateFixture(readFileSync(join(FIXTURES, "durable-1.1.0", name), "utf8")).map((f) => f.events);
		const expected = readFileSync(join(FIXTURES, "wire-v1", name), "utf8").trim().split("\n").map((line) => JSON.parse(line));
		assert.deepEqual(frames, expected, name);
	}
});

const lastUser = (ctx: TranscriptContext) => JSON.stringify(ctx.messages.findLast((m) => m.role === "user")?.content ?? "");

/** A faux host and its API on a free port. "push" asks to run git push (which waits for approval); anything else is answered. */
async function api(t: TestContext) {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", name: "Faux 1", contextWindow: 200_000 }, { id: "faux-2", name: "Faux 2" }] });
	const prompts: string[] = [];
	faux.setResponses(Array.from({ length: 100 }, () => (ctx: TranscriptContext) => {
		prompts.push(JSON.stringify(ctx.messages.filter((m) => m.role === "system")));
		const last = ctx.messages.at(-1);
		if (last?.role === "toolResult" && /pwd/.test(JSON.stringify(ctx.messages))) return fauxAssistantMessage(fauxText(`cwd: ${JSON.stringify(last.content)}`));
		if (/where are you/.test(lastUser(ctx))) return fauxAssistantMessage(fauxToolCall("bash", { command: "pwd" }), { stopReason: "toolUse" });
		if (last?.role === "toolResult") return fauxAssistantMessage(fauxText(`The push call ${last.isError ? "was blocked" : "ran"}.`));
		if (/push/.test(lastUser(ctx))) return fauxAssistantMessage(fauxToolCall("bash", { command: "git push --dry-run 2>&1 || true" }), { stopReason: "toolUse" });
		return fauxAssistantMessage(fauxText("Hello from the faux model."));
	}));
	const models = createModels();
	models.setProvider(faux.provider);
	const { host, dir } = await testHost(t, { models, model: { provider: "faux", modelId: "faux-1" } });
	const project = makeProject(dir, "one");
	const server = createApi(host, { users: [USER], appDir: join(dir, "no-app"), name: "test-host" });
	await new Promise<void>((resolve) => server.listen(0, resolve));
	t.after(() => server.close());
	return { host, project, prompts, url: `ws://127.0.0.1:${(server.server.address() as AddressInfo).port}/amyrlin` };
}

/** A protocol v1 client: requests, and each subscription's events in order with `seq` checked. */
async function client(t: TestContext, url: string) {
	const ws = new WebSocket(url, { headers: { "tailscale-user-login": USER, "tailscale-user-name": "Brad" } });
	t.after(() => ws.close());
	const responses = new Map<string, Json>();
	const events = new Map<string, Json[]>();
	const seqs = new Map<string, number>();
	const welcome: Json[] = [];
	const wakers = new Set<() => void>();
	ws.on("message", (data) => {
		const frame = JSON.parse(String(data));
		if (frame.type === "welcome") welcome.push(frame);
		if (frame.type === "response") responses.set(frame.id, frame);
		if (frame.type === "event") {
			assert.equal(frame.seq, seqs.get(frame.subscription) ?? 0, `${frame.subscription} seq`);
			seqs.set(frame.subscription, frame.seq + 1);
			events.set(frame.subscription, [...(events.get(frame.subscription) ?? []), ...frame.events]);
		}
		for (const wake of wakers) wake();
	});
	await new Promise((resolve, reject) => ws.once("open", resolve).once("error", reject));
	const until = <T>(check: () => T | undefined, what: string) =>
		new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), 5000);
			const waker = () => {
				const found = check();
				if (found === undefined) return;
				clearTimeout(timer);
				wakers.delete(waker);
				resolve(found);
			};
			wakers.add(waker);
			waker();
		});
	let next = 0;
	const request = async (method: string, params: Json = {}): Promise<Json> => {
		const id = `r${++next}`;
		ws.send(JSON.stringify({ type: "request", id, method, params }));
		const response = await until(() => responses.get(id), `the response to ${method}`);
		if (response.error !== undefined) throw Object.assign(new Error(response.error.message), { code: response.error.code, data: response.error.data });
		return response.result;
	};
	/** Resolves with the subscription's events from `from` on, once one of them matches `test`. */
	const event = (subscription: string, test: (e: Json) => boolean, what: string, from = 0) =>
		until(() => {
			const seen = (events.get(subscription) ?? []).slice(from);
			return seen.some(test) ? seen : undefined;
		}, what);
	ws.send(JSON.stringify({ type: "hello", protocols: [1], client: { name: "test", version: "0" } }));
	await until(() => welcome[0], "welcome");
	return { welcome: welcome[0], request, event, count: (subscription: string) => events.get(subscription)?.length ?? 0 };
}

const type = (name: string) => (e: Json) => e.type === name;

test("the endpoint refuses connections without a listed login, and any from a web page", async (t) => {
	const { url } = await api(t);
	for (const headers of [{}, { "tailscale-user-login": "someone@else.com" }, { "tailscale-user-login": USER, origin: "https://evil.example" }]) {
		const ws = new WebSocket(url, { headers });
		const status = await new Promise<number>((resolve) => ws.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0)));
		assert.equal(status, 403, JSON.stringify(headers));
	}
});

test("a session made from the Mac runs, shows in the host's list with its project, and pages its history", async (t) => {
	const { url, project } = await api(t);
	const mac = await client(t, url);
	assert.equal(mac.welcome.protocol, 1);
	assert.equal(mac.welcome.host.name, "test-host");
	assert.equal(mac.welcome.you.login, USER);

	const info = await mac.request("host.info");
	assert.deepEqual(info.projects.map((p: Json) => p.dir), [project.dir]);
	assert.deepEqual(info.models.map((m: Json) => m.modelId), ["faux-1"]);

	const list = (await mac.request("host.watch")).subscription;
	await mac.event(list, type("host.snapshot"), "the host snapshot");

	const created = await mac.request("conversations.create", { requestId: "mac-1", project: project.dir, text: "Say hello" });
	assert.equal(created.duplicate, false);
	assert.equal(created.conversation.title, "Say hello");
	assert.equal(created.conversation.project, "one");
	const again = await mac.request("conversations.create", { requestId: "mac-1", project: project.dir, text: "Say hello" });
	assert.equal(again.duplicate, true);
	assert.equal(again.conversation.id, created.conversation.id);
	const id = created.conversation.id;

	const watch = (await mac.request("conversation.watch", { conversationId: id })).subscription;
	// The faux model can answer before the watch starts, so the answer is in the snapshot or comes after it.
	const items = (seen: Json[]) => seen.flatMap((e) => (e.type === "snapshot" ? e.items : e.type === "item.added" ? [e.item] : []));
	const first = await mac.event(watch, (e) => items([e]).some((item: Json) => item.type === "assistant"), "the answer");
	assert.equal(first[0].type, "snapshot");
	assert.equal(first[0].conversation.project, "one");
	const answer = items(first).find((item: Json) => item.type === "assistant");
	assert.equal(answer.content[0].text, "Hello from the faux model.");
	await mac.event(list, (e) => e.type === "conversation.updated" && e.conversation.id === id && e.conversation.status === "idle", "the summary to settle");

	const from = mac.count(watch);
	const reply = await mac.request("submit", { conversationId: id, requestId: "mac-2", text: "Again" });
	assert.equal(reply.duplicate, false);
	assert.equal((await mac.request("submit", { conversationId: id, requestId: "mac-2", text: "Again" })).duplicate, true);
	await mac.event(watch, type("run.ended"), "the second run", from);

	const latest = await mac.request("conversation.history", { conversationId: id, limit: 2 });
	assert.equal(latest.items.length, 2);
	assert.equal(latest.hasEarlier, true);
	const older = await mac.request("conversation.history", { conversationId: id, before: latest.items[0].id, limit: 10 });
	assert.ok(older.items.every((item: Json) => item.id < latest.items[0].id));
});

test("aludra's approvals reach the Mac: approve, deny, and a stop while one waits", async (t) => {
	const { url, project } = await api(t);
	const mac = await client(t, url);
	const list = (await mac.request("host.watch")).subscription;
	const id = (await mac.request("conversations.create", { requestId: "a", project: project.dir })).conversation.id;
	const watch = (await mac.request("conversation.watch", { conversationId: id })).subscription;
	await mac.event(watch, type("snapshot"), "the snapshot");

	// Approve.
	let from = mac.count(watch);
	await mac.request("submit", { conversationId: id, requestId: "s1", text: "push it" });
	const asked = await mac.event(watch, type("approval.requested"), "an approval", from);
	const approval = asked.find(type("approval.requested")).approval;
	const call = asked.flatMap((e) => (e.type === "item.added" ? e.item.content ?? [] : [])).find((b: Json) => b.type === "toolCall");
	assert.equal(approval.callId, call.id, "the approval names the call it waits on");
	assert.equal(approval.toolName, "bash");
	assert.match(approval.args.command, /git push/);
	assert.equal(approval.summary, "git push");
	await mac.event(list, (e) => e.type === "conversation.updated" && e.conversation.id === id && e.conversation.status === "needsApproval", "needsApproval");
	const answered = await mac.request("approval.answer", { approvalId: approval.approvalId, decision: "approve" });
	assert.equal(answered.approval.decision, "approve");
	assert.equal((await mac.request("approval.answer", { approvalId: approval.approvalId, decision: "approve" })).approval.decision, "approve");
	await assert.rejects(mac.request("approval.answer", { approvalId: approval.approvalId, decision: "deny" }), { code: "already_resolved" });
	await mac.event(watch, (e) => e.type === "approval.resolved" && e.decision === "approve", "approval.resolved", from);
	const ran = await mac.event(watch, type("run.ended"), "the approved run", from);
	assert.equal(ran.find((e) => e.type === "item.added" && e.item.type === "toolResult").item.isError, false);

	// Deny.
	from = mac.count(watch);
	await mac.request("submit", { conversationId: id, requestId: "s2", text: "push again" });
	const second = (await mac.event(watch, type("approval.requested"), "a second approval", from)).find(type("approval.requested")).approval;
	await mac.request("approval.answer", { approvalId: second.approvalId, decision: "deny" });
	const denied = await mac.event(watch, type("run.ended"), "the denied run", from);
	const blocked = denied.find((e) => e.type === "item.added" && e.item.type === "toolResult").item;
	assert.equal(blocked.isError, true);
	assert.match(blocked.content.map((b: Json) => b.text).join(""), /Brad said no/);

	// Stop while one waits.
	from = mac.count(watch);
	await mac.request("submit", { conversationId: id, requestId: "s3", text: "push once more" });
	await mac.event(watch, type("approval.requested"), "a third approval", from);
	await mac.request("abort", { conversationId: id });
	await mac.event(watch, (e) => e.type === "approval.resolved" && e.decision === "cancelled", "the cancelled approval", from);
	const stopped = await mac.event(watch, type("run.ended"), "the stopped run", from);
	assert.ok(stopped.some((e) => e.type === "submission" && e.submission.reason === "aborted"));
});

test("settings change model and thinking only, and unsupported or unknown requests say so", async (t) => {
	const { url, project } = await api(t);
	const mac = await client(t, url);
	const id = (await mac.request("conversations.create", { requestId: "c", project: project.dir })).conversation.id;
	const watch = (await mac.request("conversation.watch", { conversationId: id })).subscription;
	await mac.event(watch, type("snapshot"), "the snapshot");
	const changed = await mac.request("configure", { conversationId: id, changes: { thinkingLevel: "low" } });
	assert.equal(changed.settings.stored.thinkingLevel, "low");
	assert.equal(changed.settings.effective.cwd, project.dir);
	await mac.event(watch, (e) => e.type === "settings.changed" && e.settings.stored.thinkingLevel === "low", "settings.changed");
	await assert.rejects(mac.request("configure", { conversationId: id, changes: { cwd: "/tmp" } }), { code: "invalid_settings" });
	await assert.rejects(mac.request("configure", { conversationId: id, changes: { model: { provider: "faux", modelId: "nope" } } }), { code: "invalid_settings" });
	await assert.rejects(mac.request("conversations.create", { requestId: "x", project: "/not/a/project" }), { code: "invalid_settings" });
	await assert.rejects(mac.request("conversations.archive", { conversationId: id, archived: true }), { code: "unsupported" });
	await assert.rejects(mac.request("submit", { conversationId: 99_999, requestId: "x", text: "x" }), { code: "not_found" });
	await assert.rejects(mac.request("no.such.method"), { code: "unknown_method" });
});

test("a session made with no project runs in a scratch directory of its own, and is told so", async (t) => {
	const { url, host, prompts } = await api(t);
	const mac = await client(t, url);
	const created = await mac.request("conversations.create", { requestId: "np", text: "where are you" });
	const summary = created.conversation;
	assert.equal(summary.project, undefined, "a no-project session has no project");
	assert.equal(summary.dir, join(host.scratchRoot, String(summary.id)));
	assert.ok(existsSync(summary.dir), "its scratch directory exists");
	const watch = (await mac.request("conversation.watch", { conversationId: summary.id })).subscription;
	const run = await mac.event(watch, type("run.ended"), "the run");
	const answer = run.find((e) => e.type === "item.added" && e.item.type === "assistant" && e.item.stopReason === "stop");
	assert.match(answer.item.content[0].text, new RegExp(String(summary.id)), "pwd ran in the scratch directory");
	assert.ok(prompts.some((p) => p.includes("isn't in a project") && p.includes(summary.dir)), "the system prompt says it has no project");
	const settings = await mac.request("configure", { conversationId: summary.id, changes: { thinkingLevel: "low" } });
	assert.equal(settings.settings.effective.cwd, summary.dir);
	const record = await host.sessions.get(summary.id);
	assert.equal(record?.scratch, true);
	assert.equal(record?.project, "no project");
});
