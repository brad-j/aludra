import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { UsageDoc } from "@earendil-works/pi-durable";
import { WebSocket } from "ws";
import { createApi } from "../src/api.ts";
import { type Json, translateFixture } from "../src/amyrlin/translate.ts";
import { context, conversationId } from "../src/host.ts";
import { makeProject, PNG, testHost } from "./helpers.ts";

const USER = "you@example.com";
const FIXTURES = join(import.meta.dirname, "fixtures", "amyrlin");

test("the translation matches amyrlin's expected frames for every recorded scenario", () => {
	const names = readdirSync(join(FIXTURES, "durable-1.1.0")).filter((f) => f.endsWith(".jsonl"));
	assert.equal(names.length, 23);
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
	const server = createApi(host, { users: [USER], name: "test-host" });
	await new Promise<void>((resolve) => server.listen(0, resolve));
	t.after(() => server.close());
	return { host, project, prompts, url: `ws://127.0.0.1:${(server.server.address() as AddressInfo).port}/amyrlin` };
}

/** A protocol v1 client: requests, and each subscription's events in order with `seq` checked. */
async function client(t: TestContext, url: string) {
	const ws = new WebSocket(url, { headers: { "tailscale-user-login": USER, "tailscale-user-name": "You" } });
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
	assert.match(blocked.content.map((b: Json) => b.text).join(""), /the user said no/);

	// Stop while one waits.
	from = mac.count(watch);
	await mac.request("submit", { conversationId: id, requestId: "s3", text: "push once more" });
	await mac.event(watch, type("approval.requested"), "a third approval", from);
	await mac.request("abort", { conversationId: id });
	await mac.event(watch, (e) => e.type === "approval.resolved" && e.decision === "cancelled", "the cancelled approval", from);
	const stopped = await mac.event(watch, type("run.ended"), "the stopped run", from);
	assert.ok(stopped.some((e) => e.type === "submission" && e.submission.reason === "aborted"));
});

test("an approval answered always lets the session push without asking, until it's forgotten", async (t) => {
	const { url, project } = await api(t);
	const mac = await client(t, url);
	const list = (await mac.request("host.watch")).subscription;
	const id = (await mac.request("conversations.create", { requestId: "a", project: project.dir })).conversation.id;
	const watch = (await mac.request("conversation.watch", { conversationId: id })).subscription;
	await mac.event(watch, type("snapshot"), "the snapshot");

	let from = mac.count(watch);
	await mac.request("submit", { conversationId: id, requestId: "s1", text: "push it" });
	const approval = (await mac.event(watch, type("approval.requested"), "an approval", from)).find(type("approval.requested")).approval;
	await assert.rejects(mac.request("approval.answer", { approvalId: approval.approvalId, decision: "deny", always: true }), { code: "bad_request" });
	await mac.request("approval.answer", { approvalId: approval.approvalId, decision: "approve", always: true });
	await mac.event(watch, type("run.ended"), "the approved run", from);
	await mac.event(list, (e) => e.type === "conversation.updated" && e.conversation.id === id && e.conversation.alwaysAllowed?.[0] === "git push", "alwaysAllowed");

	from = mac.count(watch);
	await mac.request("submit", { conversationId: id, requestId: "s2", text: "push again" });
	const again = await mac.event(watch, type("run.ended"), "the second run", from);
	assert.ok(!again.some(type("approval.requested")), "the second push didn't ask");
	assert.equal(again.find((e) => e.type === "item.added" && e.item.type === "toolResult").item.isError, false);

	const forgotten = await mac.request("approval.forget", { conversationId: id, summary: "git push" });
	assert.equal(forgotten.conversation.alwaysAllowed, undefined);
	from = mac.count(watch);
	await mac.request("submit", { conversationId: id, requestId: "s3", text: "push once more" });
	await mac.event(watch, type("approval.requested"), "an approval after forgetting", from);
	await mac.request("abort", { conversationId: id });
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
	await assert.rejects(mac.request("conversations.fork", { conversationId: id, requestId: "f" }), { code: "unsupported" });
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

test("a picked project color is in host.info and the host snapshot, and reaches every watcher", async (t) => {
	const { url } = await api(t);
	const mac = await client(t, url);
	const other = await client(t, url);
	assert.deepEqual((await mac.request("host.info")).projectColors, {});
	const { subscription } = await other.request("host.watch");
	await other.event(subscription, type("host.snapshot"), "the snapshot");

	assert.deepEqual(await mac.request("projects.setColor", { project: "one", color: 4 }), { projectColors: { one: 4 } });
	const seen = await other.event(subscription, type("host.projectColors"), "the color change");
	assert.deepEqual(seen.find(type("host.projectColors")).projectColors, { one: 4 });
	assert.deepEqual((await mac.request("host.info")).projectColors, { one: 4 });

	await assert.rejects(mac.request("projects.setColor", { project: "one", color: 11 }), { code: "bad_request" });
	await assert.rejects(mac.request("projects.setColor", { project: "one" }), { code: "bad_request" });
	assert.deepEqual(await mac.request("projects.setColor", { project: "one", color: null }), { projectColors: {} });
	const { subscription: again } = await mac.request("host.watch");
	assert.deepEqual((await mac.event(again, type("host.snapshot"), "a new snapshot")).find(type("host.snapshot")).projectColors, {});
});

test("a conversation is renamed from the Mac, and every watcher hears the new title", async (t) => {
	const { url, project } = await api(t);
	const mac = await client(t, url);
	const other = await client(t, url);
	const { conversation } = await mac.request("conversations.create", { requestId: "rename-1", project: project.dir, text: "hello" });
	const { subscription } = await other.request("host.watch");
	await other.event(subscription, type("host.snapshot"), "the snapshot");

	const renamed = await mac.request("conversations.rename", { conversationId: conversation.id, title: "Renamed" });
	assert.equal(renamed.conversation.title, "Renamed");
	await other.event(subscription, (e) => e.type === "conversation.updated" && e.conversation.title === "Renamed", "the new title");
	await assert.rejects(mac.request("conversations.rename", { conversationId: conversation.id, title: "" }), { code: "bad_request" });
	await assert.rejects(mac.request("conversations.rename", { conversationId: 999, title: "x" }), { code: "not_found" });
});

test("conversations.retitle writes the title again from the conversation, or says it couldn't", async (t) => {
	const { url, project } = await api(t);
	const mac = await client(t, url);
	const { conversation } = await mac.request("conversations.create", { requestId: "retitle-1", project: project.dir, text: "hello" });
	await mac.request("conversations.rename", { conversationId: conversation.id, title: "Kept" });
	// The faux host has no titler, so no title is written and the old one stays.
	const answer = await mac.request("conversations.retitle", { conversationId: conversation.id });
	assert.equal(answer.written, false);
	assert.equal(answer.conversation.title, "Kept");
	await assert.rejects(mac.request("conversations.retitle", { conversationId: 999 }), { code: "not_found" });
});

test("checkpoints over /amyrlin: listed, read and restored, with errors for what isn't there", async (t) => {
	const { url, project } = await api(t);
	const mac = await client(t, url);
	const { conversation } = await mac.request("conversations.create", { requestId: "cp-1", project: project.dir, text: "hello" });
	// Not a git project: no checkpoints, and nothing to restore.
	assert.deepEqual((await mac.request("checkpoints.list", { conversationId: conversation.id })).checkpoints, []);
	await assert.rejects(mac.request("checkpoints.changes", { conversationId: conversation.id, checkpoint: 1 }), { code: "not_found" });
	await assert.rejects(mac.request("checkpoints.restore", { conversationId: conversation.id, checkpoint: "1" }), { code: "bad_request" });
	await assert.rejects(mac.request("checkpoints.list", { conversationId: 999 }), { code: "not_found" });
});

test("messages.search finds what was said, and refuses a missing query or session", async (t) => {
	const { url, project } = await api(t);
	const mac = await client(t, url);
	await mac.request("conversations.create", { requestId: "search-1", project: project.dir, text: "hello there" });
	let results: Json[] = [];
	for (let i = 0; i < 100 && results.length < 2; i++) {
		results = (await mac.request("messages.search", { query: "hello" })).results;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	assert.deepEqual(results.map((r) => r.from).sort(), ["agent", "user"]);
	await assert.rejects(mac.request("messages.search", {}), { code: "bad_request" });
	await assert.rejects(mac.request("messages.search", { query: "x", conversationId: 999 }), { code: "not_found" });
});

test("a conversation is archived from the Mac: hidden from conversations.list, still in host.watch marked archived, and brought back", async (t) => {
	const { url, project } = await api(t);
	const mac = await client(t, url);
	const other = await client(t, url);
	const { conversation } = await mac.request("conversations.create", { requestId: "archive-1", project: project.dir, text: "hello" });
	const { subscription } = await other.request("host.watch");
	await other.event(subscription, type("host.snapshot"), "the snapshot");

	const archived = await mac.request("conversations.archive", { conversationId: conversation.id, archived: true });
	assert.equal(archived.conversation.archived, true);
	await other.event(subscription, (e) => e.type === "conversation.updated" && e.conversation.archived === true, "the archived flag");
	assert.equal((await mac.request("conversations.list", {})).conversations.some((c: Json) => c.id === conversation.id), false);
	assert.equal((await mac.request("conversations.list", { includeArchived: true })).conversations.find((c: Json) => c.id === conversation.id)?.archived, true);
	// Idempotent, and undone the same way.
	await mac.request("conversations.archive", { conversationId: conversation.id, archived: true });
	assert.equal((await mac.request("conversations.archive", { conversationId: conversation.id, archived: false })).conversation.archived, false);
	assert.equal((await mac.request("conversations.list", {})).conversations.some((c: Json) => c.id === conversation.id), true);
	await assert.rejects(mac.request("conversations.archive", { conversationId: conversation.id }), { code: "bad_request" });
});

test("a summary's cost is what billed providers charged, and the host has the month's total; plan-paid sessions have neither", async (t) => {
	const { url, project, host } = await api(t);
	const mac = await client(t, url);
	const { conversation } = await mac.request("conversations.create", { requestId: "cost-1", project: project.dir });
	const listed = async () => (await mac.request("conversations.list", {})).conversations.find((c: Json) => c.id === conversation.id);
	assert.equal((await listed()).cost, undefined);
	assert.equal((await mac.request("host.info")).monthCost, undefined);

	// As if it had run on OpenRouter: the ledger Pi Durable keeps, keyed provider/model.
	const used = (total: number) => ({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total } });
	await host.harness.commit(async (tx) => {
		const usage = await tx.doc(UsageDoc, conversationId(conversation.id));
		usage.models["openrouter/anthropic/claude-sonnet-5.5"] = used(0.25);
		usage.models["faux/faux-1"] = used(3);
	}, context);
	const deadline = Date.now() + 5000;
	while ((await listed()).cost === undefined && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
	const summary = await listed();
	assert.equal(summary.cost, 0.25);
	assert.ok(summary.spend.byModel["faux/faux-1"] !== undefined, "spend still has every model");
	assert.equal(typeof (await mac.request("host.info")).monthCost, "number");
});

test("an image sent from the Mac is in the transcript as a block, and conversation.image gives its bytes", async (t) => {
	const { url, project } = await api(t);
	const mac = await client(t, url);
	const { conversation } = await mac.request("conversations.create", { requestId: "img-1", project: project.dir, text: "What's this?", images: [{ mimeType: "image/png", data: PNG }] });
	assert.equal(conversation.title, "What's this?");
	const { subscription } = await mac.request("conversation.watch", { conversationId: conversation.id });
	const seen = await mac.event(subscription, (e) => e.type === "snapshot" || e.type === "item.added", "the transcript");
	const items = seen.flatMap((e: Json) => (e.type === "snapshot" ? e.items : e.type === "item.added" ? [e.item] : []));
	const user = items.find((item: Json) => item.type === "user");
	const index = user.content.findIndex((b: Json) => b.type === "image");
	assert.deepEqual(user.content[index], { type: "image", mimeType: "image/png" }, "the block says what it is, not its bytes");
	assert.deepEqual(await mac.request("conversation.image", { conversationId: conversation.id, entryId: user.id, index }), { mimeType: "image/png", data: PNG });
	await assert.rejects(mac.request("conversation.image", { conversationId: conversation.id, entryId: user.id, index: 0 }), { code: "not_found" });
	await assert.rejects(mac.request("submit", { conversationId: conversation.id, requestId: "img-2", text: "", images: [{ mimeType: "image/png", data: "nope!" }] }), { code: "bad_request" });
});

test("a video sent from the Mac is saved on the host, and the message says where, with its frames as images", async (t) => {
	const { url, project } = await api(t);
	const mac = await client(t, url);
	const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42"), Buffer.alloc(12)]).toString("base64");
	const video = { name: "flicker.mov", mimeType: "video/mp4", data: mp4, seconds: 9.5, frames: [{ mimeType: "image/png", data: PNG, at: 0 }, { mimeType: "image/png", data: PNG, at: 5 }] };
	await assert.rejects(mac.request("conversations.create", { requestId: "vid-0", project: project.dir, text: "", videos: [{ ...video, mimeType: "video/avi" }] }), { code: "bad_request" });
	assert.deepEqual((await mac.request("host.info")).videos, { maxVideos: 2, maxBytes: 40 * 1024 * 1024, maxFrames: 6, keepDays: 14 });
	const { conversation } = await mac.request("conversations.create", { requestId: "vid-1", project: project.dir, text: "", videos: [video] });
	assert.equal(conversation.title, "A video");
	const { subscription } = await mac.request("conversation.watch", { conversationId: conversation.id });
	const seen = await mac.event(subscription, (e) => e.type === "snapshot" || e.type === "item.added", "the transcript");
	const items = seen.flatMap((e: Json) => (e.type === "snapshot" ? e.items : e.type === "item.added" ? [e.item] : []));
	const user = items.find((item: Json) => item.type === "user");
	assert.deepEqual(user.content.map((b: Json) => b.type), ["text", "image", "image"]);
	const path = /path="([^"]+)"/.exec(user.content[0].text)?.[1];
	assert.ok(path?.endsWith("-flicker.mp4"), user.content[0].text);
	assert.deepEqual(readFileSync(path!), Buffer.from(mp4, "base64"));
	// A retry of the same submit gets the first back and saves no second copy.
	const send = () => mac.request("submit", { conversationId: conversation.id, requestId: "vid-2", text: "and this", videos: [video] });
	assert.equal((await send()).duplicate, false);
	assert.equal((await send()).duplicate, true);
	assert.equal(readdirSync(dirname(path!)).length, 2);
});
