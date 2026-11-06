import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
import { configFor } from "../src/config.ts";
import { context, conversationId, type HostOptions, openHost } from "../src/host.ts";
import { PAGE_CSP, Pages } from "../src/pages.ts";
import { removeSandboxesOnArchive } from "../src/sandbox-cleanup.ts";
import type { Sandboxes } from "../src/sandboxes.ts";
import { fakeGh, fakeSandboxes, git, gitProject, makeProject, PNG, SANDBOX_SETTINGS, tempDir, testHost } from "./helpers.ts";

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

/** The faux model's answer to "report NAME": prose, a done plan and a result block that asks something. */
const REPORTED = [
	"I wrote the file.",
	"",
	"```plan\n- [x] Write the file\n```",
	"",
	"```result",
	JSON.stringify({ summary: "The file is written. It's small.", changes: ["There's a new file."], headsUp: [{ kind: "left", text: "Nothing left over." }], question: { text: "Keep it short?", options: ["Yes", "No"] } }),
	"```",
].join("\n");

const lastUser = (ctx: TranscriptContext) => JSON.stringify(ctx.messages.findLast((m) => m.role === "user")?.content ?? "");

/**
 * A faux host and its API on a free port. "push" asks to run git push (which waits for approval); "commit NAME" writes
 * NAME.txt and commits it; a ship prompt rebases onto refs/aludra/base and says SHIP-READY, or SHIP-BLOCKED when the
 * ship's note says "block"; anything else is answered. With `sandboxes`, the host has a sandbox host.
 */
async function api(t: TestContext, options: { sandboxes?: Sandboxes; dir?: string; settings?: Record<string, unknown>; newProjects?: HostOptions["newProjects"] } = {}) {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", name: "Faux 1", contextWindow: 200_000 }, { id: "faux-2", name: "Faux 2" }] });
	const prompts: string[] = [];
	faux.setResponses(Array.from({ length: 100 }, () => (ctx: TranscriptContext) => {
		prompts.push(JSON.stringify(ctx.messages.filter((m) => m.role === "system")));
		const last = ctx.messages.at(-1);
		if (last?.role === "toolResult" && /pwd/.test(JSON.stringify(ctx.messages))) return fauxAssistantMessage(fauxText(`cwd: ${JSON.stringify(last.content)}`));
		if (/where are you/.test(lastUser(ctx))) return fauxAssistantMessage(fauxToolCall("bash", { command: "pwd" }), { stopReason: "toolUse" });
		const user = lastUser(ctx);
		if (last?.role === "toolResult" && /refs\/aludra\/base/.test(user)) return fauxAssistantMessage(fauxText("Rebased and tested.\nSHIP-READY"));
		if (last?.role === "toolResult" && /report \w+/.test(user)) return fauxAssistantMessage(fauxText(REPORTED));
		if (last?.role === "toolResult" && /commit \w+/.test(user)) return fauxAssistantMessage(fauxText(`Committed: ${JSON.stringify(last.content)}`));
		if (last?.role === "toolResult") return fauxAssistantMessage(fauxText(`The push call ${last.isError ? "was blocked" : "ran"}.`));
		if (/refs\/aludra\/base/.test(user) && /note from the user[^\\]*block/.test(user)) return fauxAssistantMessage(fauxText("A conflict needs you.\nSHIP-BLOCKED: which title to keep"));
		if (/refs\/aludra\/base/.test(user)) return fauxAssistantMessage([fauxText("```plan\n- [x] Bring in the upstream\n- [ ] Rebase\n```"), fauxToolCall("bash", { command: "sleep 0.4; git rebase -q refs/aludra/base 2>&1" })], { stopReason: "toolUse" });
		// "report NAME" commits NAME.txt with a plan, then answers with a result block.
		const reported = /report (\w+)/.exec(user)?.[1];
		if (reported !== undefined) return fauxAssistantMessage([fauxText("```plan\n- [ ] Write the file\n```"), fauxToolCall("bash", { command: `echo ${reported} > ${reported}.txt && echo more >> a.txt && git add a.txt ${reported}.txt && git -c user.name=t -c user.email=t@example.com commit -q -m ${reported} && pnpm test 2>&1 || true` })], { stopReason: "toolUse" });
		const name = /commit (\w+)/.exec(user)?.[1];
		if (name !== undefined) return fauxAssistantMessage(fauxToolCall("bash", { command: `echo ${name} > ${name}.txt && git add ${name}.txt && git -c user.name=t -c user.email=t@example.com commit -q -m ${name} && git log -1 --format=%s` }), { stopReason: "toolUse" });
		if (/push/.test(user)) return fauxAssistantMessage(fauxToolCall("bash", { command: "git push --dry-run 2>&1 || true" }), { stopReason: "toolUse" });
		return fauxAssistantMessage(fauxText("Hello from the faux model."));
	}));
	const models = createModels();
	models.setProvider(faux.provider);
	const { host, dir } = await testHost(t, { models, model: { provider: "faux", modelId: "faux-1" }, ...(options.sandboxes === undefined ? (options.settings === undefined ? {} : { settings: options.settings }) : { sandboxes: options.sandboxes, settings: { ...SANDBOX_SETTINGS, ...options.settings } }), ...(options.dir === undefined ? {} : { dir: options.dir }), ...(options.newProjects === undefined ? {} : { newProjects: options.newProjects }) });
	const project = options.dir !== undefined || options.sandboxes !== undefined ? { workspace: "test", name: "one", path: "Software/one", dir: join(dir, "Projects", "Software", "one") } : makeProject(dir, "one");
	const server = createApi(host, { users: [USER], name: "test-host", checkoutMs: 100 });
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

test("an archived project is marked in host.info, reaches every watcher as host.projects, and comes back", async (t) => {
	const { url, project } = await api(t);
	const mac = await client(t, url);
	const other = await client(t, url);
	const listed = (info: Json) => info.projects.find((p: Json) => p.dir === project.dir);
	assert.equal(listed(await mac.request("host.info")).archived, undefined);
	const { subscription } = await other.request("host.watch");
	await other.event(subscription, type("host.snapshot"), "the snapshot");

	const answer = await mac.request("projects.archive", { project: project.dir, archived: true });
	assert.equal(answer.archived, true);
	assert.equal(answer.project.dir, project.dir);
	assert.equal(answer.project.archived, true);
	const seen = await other.event(subscription, (e) => e.type === "host.projects" && e.projects.some((p: Json) => p.dir === project.dir && p.archived === true), "the archived project");
	assert.ok(seen.length > 0);
	assert.equal(listed(await mac.request("host.info")).archived, true);
	// Archiving twice is the same as once, and a name finds the project as a directory does.
	assert.equal((await mac.request("projects.archive", { project: "one", archived: true })).archived, true);

	await assert.rejects(mac.request("projects.archive", { project: "nowhere" }), { code: "bad_request" });
	await assert.rejects(mac.request("projects.archive", { archived: true }), { code: "bad_request" });
	assert.equal((await mac.request("projects.archive", { project: "one", archived: false })).project.archived, undefined);
	await other.event(subscription, (e) => e.type === "host.projects" && e.projects.some((p: Json) => p.dir === project.dir && p.archived === undefined), "the project back");
	assert.equal(listed(await mac.request("host.info")).archived, undefined);
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

test("files sent from the Mac are saved on the host, and the message says where; a retry saves none again", async (t) => {
	const { url, project } = await api(t);
	const mac = await client(t, url);
	const file = { name: "server.log", mimeType: "text/plain", data: Buffer.from("boom").toString("base64") };
	assert.deepEqual((await mac.request("host.info")).files, { maxFiles: 20, maxBytes: 25 * 1024 * 1024, pasteBytes: 32 * 1024, keepDays: 14, maxMessageBytes: 80 * 1024 * 1024 });
	await assert.rejects(mac.request("conversations.create", { requestId: "file-0", project: project.dir, text: "", files: [{ name: "x" }] }), { code: "bad_request" });
	const { conversation } = await mac.request("conversations.create", { requestId: "file-1", project: project.dir, text: "", files: [file] });
	assert.equal(conversation.title, "server.log");
	const { subscription } = await mac.request("conversation.watch", { conversationId: conversation.id });
	const seen = await mac.event(subscription, (e) => e.type === "snapshot" || e.type === "item.added", "the transcript");
	const user = seen.flatMap((e: Json) => (e.type === "snapshot" ? e.items : e.type === "item.added" ? [e.item] : [])).find((item: Json) => item.type === "user");
	const path = /path="([^"]+)"/.exec(user.content[0].text)?.[1];
	assert.ok(path?.endsWith("-server.log"), user.content[0].text);
	assert.equal(readFileSync(path!, "utf8"), "boom");
	const send = () => mac.request("submit", { conversationId: conversation.id, requestId: "file-2", text: "and this", files: [file] });
	assert.equal((await send()).duplicate, false);
	assert.equal((await send()).duplicate, true);
	assert.equal(readdirSync(dirname(path!)).length, 2);
});

test("conversation.page answers a page the agent published, with its policy, and not_found for one that isn't there", async (t) => {
	const { url, project, host } = await api(t);
	const mac = await client(t, url);
	assert.equal((await mac.request("host.info")).pages, true);
	const { conversation } = await mac.request("conversations.create", { requestId: "page-1", project: project.dir, text: "hello" });
	await host.root.commit(async (tx) => {
		const doc = await tx.doc(Pages, `${conversation.id}/1`, null);
		doc.title = "Chart";
		doc.html = "<html><head></head><body>x</body></html>";
		doc.createdAt = 5;
	}, context);
	const page = await mac.request("conversation.page", { conversationId: conversation.id, page: 1 });
	assert.deepEqual([page.page, page.title, page.html, page.createdAt, page.csp], [1, "Chart", "<html><head></head><body>x</body></html>", 5, PAGE_CSP]);
	await assert.rejects(mac.request("conversation.page", { conversationId: conversation.id, page: 2 }), { code: "not_found" });
	await assert.rejects(mac.request("conversation.page", { conversationId: conversation.id }), { code: "bad_request" });
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

/** A host with sandboxes over pi-env's local daemon, and project "one" in git with origin/main a bare repository. */
async function sandboxApi(t: TestContext) {
	const root = tempDir(t);
	const { project, remote } = gitProject(root, "one", { "a.txt": "one\n" }, { remote: true });
	const fake = fakeSandboxes(root);
	t.after(() => fake.close());
	// New projects go beside "one", with a gh that makes local bare repositories.
	const served = await api(t, { sandboxes: fake.sandboxes, dir: root, settings: { newProjects: { root: join(root, "Projects", "Software"), owner: "t" } }, newProjects: fakeGh(join(root, "github")) });
	return { ...served, project, remote: remote!, fake, root };
}

const updated = (id: number, test: (c: Json) => boolean) => (e: Json) => e.type === "conversation.updated" && e.conversation.id === id && test(e.conversation);

test("a sandbox session from the Mac answers at once, holds its first message while it's made, then runs in it", async (t) => {
	const { url, project, fake } = await sandboxApi(t);
	const mac = await client(t, url);
	const info = await mac.request("host.info");
	assert.deepEqual(info.sandboxes, { shipTo: "main", afterRun: "fetch", approvals: "off" });
	const list = (await mac.request("host.watch")).subscription;
	await mac.event(list, type("host.snapshot"), "the host snapshot");

	fake.control.hold = true;
	const created = await mac.request("conversations.create", { requestId: "sb-1", project: project.dir, text: "commit hello", sandbox: true });
	const id = created.conversation.id;
	assert.equal(created.conversation.sandbox.state, "preparing");
	assert.equal(created.conversation.sandbox.number, 0);
	assert.equal(created.conversation.sandbox.branch, "sandbox/0");
	assert.equal(created.conversation.source, project.dir);
	assert.equal(created.conversation.status, "busy", "a held message counts as work going on");
	// The step can be in the answer already, or come after it.
	if (created.conversation.sandbox.step !== "cloning") await mac.event(list, updated(id, (c) => c.sandbox.step === "cloning"), "the cloning step");
	// A second message waits too, in order.
	const queued = await mac.request("submit", { conversationId: id, requestId: "sb-2", text: "commit again" });
	assert.equal(queued.submission.status, "queued");
	assert.equal((await mac.request("conversations.create", { requestId: "sb-1", project: project.dir, text: "commit hello", sandbox: true })).duplicate, true);

	fake.control.release();
	const ready = await mac.event(list, updated(id, (c) => c.sandbox.state === "ready" && c.status === "idle" && c.updatedAt > c.createdAt), "the runs in the sandbox");
	const summary = ready.findLast(updated(id, (c) => c.sandbox.state === "ready")).conversation;
	assert.equal(summary.sandbox.base, git(project.dir, "rev-parse", "HEAD"));
	assert.equal(summary.sandbox.step, undefined);
	assert.equal(summary.dir, fake.made[0]!.dir, "dir is in the sandbox");
	const box = fake.made[0]!.dir;
	// Both messages ran in the sandbox, in order, and nothing was written to the project here.
	await waitFor(() => git(box, "log", "--format=%s").split("\n").length === 3, "both commits in the sandbox");
	assert.deepEqual(git(box, "log", "--format=%s").split("\n"), ["again", "hello", "first"]);
	assert.equal(git(project.dir, "status", "--porcelain"), "");
	const history = await mac.request("conversation.history", { conversationId: id, limit: 50 });
	const users = history.items.filter((i: Json) => i.type === "user").map((i: Json) => i.content[0].text);
	assert.deepEqual(users, ["commit hello", "commit again"]);
});

test("sandbox.sync brings the branch home, sandbox.discard deletes it, and refusals say why", async (t) => {
	const { url, host, project, fake } = await sandboxApi(t);
	const mac = await client(t, url);
	const id = (await mac.request("conversations.create", { requestId: "c", project: project.dir, text: "commit work", sandbox: true })).conversation.id;
	await host.sandboxes.prepared(id);
	await waitFor(async () => (await host.sessions.states()).get(id) === "idle" && git(fake.made[0]!.dir, "log", "--format=%s").startsWith("work"), "the commit");

	const synced = await mac.request("sandbox.sync", { conversationId: id });
	assert.equal(synced.branch, "sandbox/0");
	assert.equal(synced.commits, 1);
	assert.equal(synced.uncommitted, 0);
	assert.equal(synced.merged, undefined);
	assert.equal(git(project.dir, "rev-parse", "sandbox/0"), git(fake.made[0]!.dir, "rev-parse", "HEAD"));
	const merged = await mac.request("sandbox.sync", { conversationId: id, merge: true });
	assert.equal(merged.merged, true);
	assert.equal(git(project.dir, "log", "-1", "--format=%s", "main"), "work", "main fast-forwarded");

	assert.deepEqual(await mac.request("sandbox.discard", { conversationId: id }), { branch: "sandbox/0", deleted: true });
	assert.equal(git(project.dir, "branch", "--list", "sandbox/0"), "");
	assert.deepEqual(await mac.request("sandbox.discard", { conversationId: id }), { branch: "sandbox/0", deleted: false });
	assert.equal((await host.sessions.get(id))?.sandboxDiscarded, true);

	// Archived after a discard, the sandbox goes without its branch coming back. `aludra serve` runs this cleanup.
	const cleanup = removeSandboxesOnArchive(host, () => {});
	t.after(cleanup.stop);
	await mac.request("conversations.archive", { conversationId: id, archived: true });
	await waitFor(async () => (await host.sessions.get(id))?.sandboxRemoved === true, "the sandbox removed");
	assert.equal(git(project.dir, "branch", "--list", "sandbox/0"), "");
	assert.deepEqual(fake.removed, [0]);
	await waitFor(async () => (await mac.request("conversations.list", { includeArchived: true })).conversations.find((c: Json) => c.id === id).sandbox.state === "removed", "the summary to say removed");

	const local = (await mac.request("conversations.create", { requestId: "here", project: project.dir })).conversation.id;
	await assert.rejects(mac.request("sandbox.sync", { conversationId: local }), { code: "bad_request" });
	await assert.rejects(mac.request("sandbox.ship", { conversationId: local }), { code: "bad_request" });
	await assert.rejects(mac.request("sandbox.sync", { conversationId: id }), { code: "bad_request", message: /deleted/ });
	await assert.rejects(mac.request("conversations.create", { requestId: "x", project: project.dir, approvals: "off" }), { code: "bad_request" });
});

test("a sandbox that can't be made leaves the session stuck with the reason, and its message unsent", async (t) => {
	const { url, project, fake } = await sandboxApi(t);
	const mac = await client(t, url);
	const list = (await mac.request("host.watch")).subscription;
	fake.control.fail = "the template's install failed";
	await mac.event(list, type("host.snapshot"), "the host snapshot");
	const created = (await mac.request("conversations.create", { requestId: "f", project: project.dir, text: "commit x", sandbox: true })).conversation;
	const id = created.id;
	// The failure can beat the answer, or come after it.
	const failed = created.status === "stuck" ? created : (await mac.event(list, updated(id, (c) => c.status === "stuck"), "the failure")).findLast(updated(id, (c) => c.status === "stuck")).conversation;
	assert.match(failed.sandbox.reason, /install failed/);
	assert.equal(failed.status, "stuck");
	assert.equal(failed.stuck.reason, "sandbox_failed");
	await assert.rejects(mac.request("submit", { conversationId: id, requestId: "f2", text: "again" }), { code: "bad_request", message: /couldn't be made/ });
	const history = await mac.request("conversation.history", { conversationId: id });
	assert.equal(history.items.filter((i: Json) => i.type === "user").length, 0);
});

test("a message held while the sandbox is made survives a restart, and is sent once the sandbox is ready", async (t) => {
	const root = tempDir(t);
	const { project } = gitProject(root, "one");
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	faux.setResponses(Array.from({ length: 10 }, () => (ctx: TranscriptContext) => (ctx.messages.at(-1)?.role === "toolResult" ? fauxAssistantMessage(fauxText("done")) : fauxAssistantMessage(fauxToolCall("bash", { command: "echo kept > kept.txt && git add kept.txt && git -c user.name=t -c user.email=t@example.com commit -q -m kept" }), { stopReason: "toolUse" }))));
	const models = createModels();
	models.setProvider(faux.provider);
	const model = { provider: "faux", modelId: "faux-1" };
	const first = fakeSandboxes(root);
	first.control.hold = true;
	const before = await testHost(t, { dir: root, sandboxes: first.sandboxes, settings: SANDBOX_SETTINGS, models, model });
	const record = await before.host.sessions.startSandbox(project, "commit kept");
	assert.equal(await before.host.sandboxes.hold(record.id, "commit kept", "k1"), true);
	assert.equal(await before.host.sandboxes.hold(record.id, "commit kept", "k1"), true, "a retry holds nothing twice");
	assert.equal((await before.host.sandboxes.held(record.id)).length, 1);
	await before.host.close();
	first.close();

	// The next process finds it preparing and makes the sandbox again.
	const second = fakeSandboxes(root);
	t.after(() => second.close());
	const after = await testHost(t, { dir: root, sandboxes: second.sandboxes, settings: SANDBOX_SETTINGS, models, model });
	await waitFor(async () => (await after.host.sessions.get(record.id))?.sandboxState !== "preparing", "the sandbox made after the restart");
	const rec = await after.host.sessions.get(record.id);
	assert.equal(rec?.sandboxState, "ready", rec?.sandboxReason ?? "");
	await waitFor(() => second.made.length === 1 && git(second.made[0]!.dir, "log", "-1", "--format=%s") === "kept", "the held message run");
	assert.deepEqual(await after.host.sandboxes.held(record.id), []);
});

test("sandbox.ship lands the work on origin/main and tells host watchers, and a blocked ship says so with its kind", async (t) => {
	const { url, host, project, remote, fake, root } = await sandboxApi(t);
	const mac = await client(t, url);
	const list = (await mac.request("host.watch")).subscription;
	const id = (await mac.request("conversations.create", { requestId: "s", project: project.dir, text: "commit feature", sandbox: true })).conversation.id;
	await host.sandboxes.prepared(id);
	await waitFor(async () => (await host.sessions.states()).get(id) === "idle" && git(fake.made[0]!.dir, "log", "-1", "--format=%s") === "feature", "the commit");
	// Meanwhile origin/main moves.
	const other = join(root, "other");
	execFileSync("git", ["clone", "-q", remote, other]);
	git(other, "commit", "-q", "--allow-empty", "-m", "someone else's");
	git(other, "push", "-q", "origin", "main");

	const from = mac.count(list);
	assert.deepEqual(await mac.request("sandbox.ship", { conversationId: id }), { started: true });
	await assert.rejects(mac.request("sandbox.ship", { conversationId: id }), { code: "busy" });
	// The line follows the ship's plan.
	await mac.event(list, updated(id, (c) => c.line === "Shipping · Rebase"), "the ship's step in the line", from);
	const shipped = (await mac.event(list, type("sandbox.shipped"), "sandbox.shipped", from)).find(type("sandbox.shipped"));
	assert.equal(shipped.shipped, true, JSON.stringify(shipped));
	assert.equal(shipped.conversationId, id);
	assert.equal(shipped.to, "main");
	assert.equal(shipped.pushed, "origin/main");
	assert.equal(shipped.commits, 1);
	assert.deepEqual(git(remote, "log", "--format=%s", "main").split("\n"), ["feature", "someone else's", "first"]);
	assert.equal((await host.sessions.get(id))?.shipping, undefined, "the ship is done in the record");
	// The summary keeps it, for a client that wasn't watching, and its line and result say it in plain words.
	const summaryOf = async () => (await mac.request("conversations.list")).conversations.find((c: Json) => c.id === id);
	await waitFor(async () => (await summaryOf()).sandbox.shipped !== undefined, "the summary to keep the ship");
	const landed = await summaryOf();
	// `unchecked`, as the test project declares no checks and its turn ran none.
	assert.deepEqual(Object.keys(landed.sandbox.shipped).sort(), ["at", "commits", "head", "pushed", "to", "unchecked"]);
	assert.equal(landed.sandbox.shipped.pushed, "origin/main");
	assert.equal(landed.sandbox.shipped.head, shipped.head);
	assert.equal(landed.sandbox.shipStopped, undefined);
	await waitFor(async () => (await mac.request("conversations.list")).conversations.find((c: Json) => c.id === id).line === "Shipped to main · 1 commit", "the line after the ship");
	assert.equal((await mac.request("task.result", { conversationId: id })).result.summary, "Shipped to main: 1 commit.", "the ship's answer had no result block");

	// A note that blocks it: the session says SHIP-BLOCKED, and nothing is pushed.
	git(fake.made[0]!.dir, "commit", "-q", "--allow-empty", "-m", "more");
	const before = git(remote, "rev-parse", "main");
	const next = mac.count(list);
	await mac.request("sandbox.ship", { conversationId: id, note: "block it" });
	const stopped = (await mac.event(list, type("sandbox.shipped"), "the blocked ship", next)).find(type("sandbox.shipped"));
	assert.equal(stopped.shipped, false);
	assert.equal(stopped.kind, "blocked");
	assert.match(stopped.reason, /which title to keep/);
	assert.equal(git(remote, "rev-parse", "main"), before);
	await waitFor(async () => (await summaryOf()).sandbox.shipStopped !== undefined, "the summary to keep the stopped ship");
	const after = await summaryOf();
	assert.equal(after.sandbox.shipStopped.kind, "blocked");
	assert.equal(after.sandbox.shipStopped.reason, "which title to keep");
	assert.equal(after.sandbox.shipped.head, shipped.head, "the landed ship is kept");
	await waitFor(async () => (await mac.request("conversations.list")).conversations.find((c: Json) => c.id === id).line === "Ship stopped · which title to keep", "the line after the stopped ship");
	// A message after it: the line goes back to the work, and the stopped ship stays until the next ship starts.
	await mac.request("submit", { conversationId: id, requestId: "after-ship", text: "hello" });
	await waitFor(async () => {
		const c = (await mac.request("conversations.list")).conversations.find((c: Json) => c.id === id);
		return c.status === "idle" && c.line === "Hello from the faux model.";
	}, "the line after a new message");
	assert.equal((await mac.request("conversations.list")).conversations.find((c: Json) => c.id === id).sandbox.shipStopped.kind, "blocked");
	await mac.request("sandbox.ship", { conversationId: id });
	await waitFor(async () => (await mac.request("conversations.list")).conversations.find((c: Json) => c.id === id).sandbox.shipStopped === undefined, "the stopped ship cleared when the next starts");
	await host.ships.settled();
});

test("attempts at one ask share a group, and group.keep archives the others, their branches and sandboxes gone", async (t) => {
	const { url, host, project, fake } = await sandboxApi(t);
	const mac = await client(t, url);
	const cleanup = removeSandboxesOnArchive(host, () => {});
	t.after(cleanup.stop);
	await assert.rejects(mac.request("conversations.create", { requestId: "g0", project: project.dir, text: "x", group: "g" }), { code: "bad_request", message: /sandbox/ });
	const ids: number[] = [];
	for (const n of [1, 2, 3]) ids.push((await mac.request("conversations.create", { requestId: `g${n}`, project: project.dir, text: `commit try${n}`, sandbox: true, group: "three" })).conversation.id);
	const other = (await mac.request("conversations.create", { requestId: "g4", project: project.dir, text: "commit alone", sandbox: true })).conversation.id;
	for (const id of [...ids, other]) await host.sandboxes.prepared(id);
	await waitFor(async () => {
		const states = await host.sessions.states();
		return [...ids, other].every((id) => states.get(id) === "idle");
	}, "the attempts");
	for (const id of [...ids, other]) await host.sandboxes.sync(id);
	const listed = (await mac.request("conversations.list")).conversations;
	assert.deepEqual(ids.map((id) => listed.find((c: Json) => c.id === id).sandbox.group), ["three", "three", "three"]);
	assert.equal(listed.find((c: Json) => c.id === other).sandbox.group, undefined);

	await assert.rejects(mac.request("group.keep", { group: "three", conversationId: other }), { code: "bad_request" });
	const kept = await mac.request("group.keep", { group: "three", conversationId: ids[1] });
	assert.deepEqual(kept.archived.sort(), [ids[0], ids[2]].sort());
	const branches = git(project.dir, "for-each-ref", "--format=%(refname:short)", "refs/heads/sandbox/");
	const branchOf = (id: number) => listed.find((c: Json) => c.id === id).sandbox.branch;
	assert.ok(branches.includes(branchOf(ids[1]!)) && branches.includes(branchOf(other)), branches);
	assert.ok(!branches.includes(branchOf(ids[0]!)) && !branches.includes(branchOf(ids[2]!)), branches);
	await waitFor(() => fake.removed.length === 2, "the two sandboxes removed");
	const archived = async () => {
		const all = (await mac.request("conversations.list", { includeArchived: true })).conversations;
		return ids.map((id) => all.find((c: Json) => c.id === id).archived);
	};
	await waitFor(async () => JSON.stringify(await archived()) === "[true,false,true]", "the summaries to say archived");
});

async function waitFor(check: () => boolean | Promise<boolean>, what: string, ms = 8000) {
	const deadline = Date.now() + ms;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

test("a sandbox task's result: what it said, its checks run in the sandbox, its code, and its line", async (t) => {
	const { url, host, project, fake, prompts } = await sandboxApi(t);
	const mac = await client(t, url);
	const list = (await mac.request("host.watch")).subscription;
	await mac.event(list, type("host.snapshot"), "the host snapshot");
	fake.control.hold = true;
	const created = (await mac.request("conversations.create", { requestId: "r", project: project.dir, text: "report notes", sandbox: true })).conversation;
	const id = created.id;
	assert.deepEqual(await mac.request("task.result", { conversationId: id }), { result: null });
	if (created.line !== "Making its sandbox · cloning") await mac.event(list, updated(id, (c) => c.line === "Making its sandbox · cloning"), "the line while it's made");
	fake.control.release();
	await host.sandboxes.prepared(id);
	// The project declares one check that passes and one that fails; aludra serve runs them once a run ends.
	const box = fake.made[0]!.dir;
	mkdirSync(join(box, ".agents"), { recursive: true });
	writeFileSync(join(box, ".agents", "project.json"), JSON.stringify({ checks: ["true", { name: "fails", command: "echo broken; exit 3" }] }));
	await waitFor(async () => (await host.sessions.states()).get(id) === "idle" && git(box, "log", "-1", "--format=%s") === "notes", "the run");
	await host.sandboxes.sync(id);

	// Before the declared checks run, checks come from the turn's own test and build calls: its pnpm test, ended `|| true`.
	const before = (await mac.request("task.result", { conversationId: id })).result;
	assert.deepEqual(before.checks, [{ name: "pnpm test", ok: true }]);
	assert.equal(before.summary, "The file is written. It's small.");
	assert.deepEqual(before.changes, ["There's a new file."]);
	assert.deepEqual(before.headsUp, [{ kind: "left", text: "Nothing left over." }]);
	assert.deepEqual(before.question, { text: "Keep it short?", options: ["Yes", "No"] });
	assert.deepEqual(before.plan, [{ text: "Write the file", done: true }]);
	assert.deepEqual(before.shots, []);
	assert.deepEqual(before.code, { commits: 1, files: 2, add: 2, del: 0 });
	assert.equal(typeof before.at, "number");

	await host.results.afterRun(id);
	const after = (await mac.request("task.result", { conversationId: id })).result;
	assert.deepEqual(after.checks.map((c: Json) => [c.name, c.ok]), [["true", true], ["fails", false]]);
	assert.match(after.checks[1].detail, /broken/);
	// The line says what it asks, as the question is open.
	await mac.event(list, updated(id, (c) => c.line === "Asks: Keep it short?"), "the line");

	const code = await mac.request("task.code", { conversationId: id });
	assert.deepEqual(code.changes.files.map((f: Json) => [f.path, f.status]).sort(), [["a.txt", "modified"], ["notes.txt", "added"]]);
	assert.match((await mac.request("task.code", { conversationId: id, path: "notes.txt" })).patch, /\+notes/);
	await assert.rejects(mac.request("task.code", { conversationId: id, path: "nope.txt" }), { code: "not_found" });
	await assert.rejects(mac.request("task.shot", { conversationId: id, shot: "x" }), { code: "not_found" });

	assert.match(prompts.find((p) => p.includes("```result")) ?? "", /```plan/, "the sandbox section asks for both blocks");
	const local = (await mac.request("conversations.create", { requestId: "here", project: project.dir })).conversation.id;
	assert.deepEqual(await mac.request("task.result", { conversationId: local }), { result: null });
	assert.deepEqual((await mac.request("task.code", { conversationId: local })).changes.files, [], "a local session's own changes, none yet");
});

test("every session's prompt asks for the plan and result blocks: on this machine, in no project, and in a sandbox", async (t) => {
	const { url, host, project, prompts } = await sandboxApi(t);
	const mac = await client(t, url);
	const promptOf = async (params: Json) => {
		const from = prompts.length;
		const id = (await mac.request("conversations.create", { requestId: `p${from}`, ...params })).conversation.id;
		if (params.sandbox === true) await host.sandboxes.prepared(id);
		await waitFor(() => prompts.length > from, "a request");
		return prompts[from]!;
	};
	for (const params of [{ project: project.dir, text: "hi" }, { text: "hi" }, { project: project.dir, text: "hi", sandbox: true }]) {
		const prompt = await promptOf(params);
		assert.match(prompt, /```plan/, JSON.stringify(params));
		assert.match(prompt, /```result/, JSON.stringify(params));
		assert.match(prompt, /options become buttons/, JSON.stringify(params));
	}
});

test("with ALUDRA_SANDBOXES=fake the host serves local sandboxes, and the faux model answers plan and question", async (t) => {
	const root = tempDir(t);
	const { project } = gitProject(root, "one");
	// The host's own faux model and its own fake sandboxes, as aludra serve makes them.
	const { config } = configFor(JSON.stringify({ dataDir: join(root, "data"), workspaces: [{ name: "test", roots: [join(root, "Projects", "*", "*")] }] }), { ALUDRA_MODEL: "faux", ALUDRA_SANDBOXES: "fake" });
	const host = await openHost({ config, agentDir: join(root, "agent") });
	t.after(() => host.close());
	host.resume();
	const server = createApi(host, { users: [USER], name: "test-host", checkoutMs: 100 });
	await new Promise<void>((resolve) => server.listen(0, resolve));
	t.after(() => server.close());
	const mac = await client(t, `ws://127.0.0.1:${(server.server.address() as AddressInfo).port}/amyrlin`);
	const info = await mac.request("host.info");
	assert.deepEqual(info.sandboxes, { shipTo: "main", afterRun: "fetch", approvals: "off" });
	assert.equal(info.projects[0].checkout.sandboxes, true);

	const id = (await mac.request("conversations.create", { requestId: "f", project: project.dir, text: "make a plan", sandbox: true })).conversation.id;
	await host.sandboxes.prepared(id);
	const record = await host.sessions.get(id);
	assert.equal(record?.sandbox, 0);
	assert.ok(record!.dir.startsWith(join(root, "data", "fake-sandboxes")), "the sandbox is a clone in the data directory");
	await waitFor(async () => (await mac.request("task.result", { conversationId: id })).result?.plan?.length === 3, "the plan while it runs");
	const running = (await mac.request("task.result", { conversationId: id })).result;
	assert.deepEqual(running.plan.map((s: Json) => s.done), [true, false, false]);
	await waitFor(async () => (await host.sessions.states()).get(id) === "idle", "the run", 15000);
	const planned = (await mac.request("task.result", { conversationId: id })).result;
	assert.deepEqual(planned.plan.map((s: Json) => s.done), [true, true, true]);
	assert.equal(planned.summary, "Read the project and looked around its directory.");
	assert.deepEqual([planned.changes, planned.headsUp], [[], []]);

	await mac.request("submit", { conversationId: id, requestId: "q", text: "ask me a question" });
	await waitFor(async () => (await mac.request("task.result", { conversationId: id })).result?.question !== undefined, "the question");
	const asked = (await mac.request("task.result", { conversationId: id })).result;
	assert.equal(asked.question.text, "Which layout should the list use?");
	assert.ok(asked.question.options.length >= 2 && asked.question.options.length <= 3);
	assert.equal(asked.summary, "There are a few ways to go from here, and it's your call.");
});

test("task.code for a session on this machine is its changes since it started, and one file's patch", async (t) => {
	const { url, host, project } = await sandboxApi(t);
	const mac = await client(t, url);
	// Uncommitted before it started, so not the session's.
	writeFileSync(join(project.dir, "before.txt"), "already here\n");
	const id = (await mac.request("conversations.create", { requestId: "here", project: project.dir, text: "commit hello" })).conversation.id;
	await waitFor(async () => (await host.sessions.states()).get(id) === "idle" && git(project.dir, "log", "-1", "--format=%s") === "hello", "the commit here");
	const { changes } = await mac.request("task.code", { conversationId: id });
	assert.equal(changes.available, true);
	assert.deepEqual(changes.files.map((f: Json) => [f.path, f.status, f.add]), [["hello.txt", "added", 1]]);
	assert.match((await mac.request("task.code", { conversationId: id, path: "hello.txt" })).patch, /\+hello/);
	await assert.rejects(mac.request("task.code", { conversationId: id, path: "before.txt" }), { code: "not_found" });
	await assert.rejects(mac.request("task.code", { conversationId: id, path: 3 }), { code: "bad_request" });

	// A session with no recorded start (here, a project that isn't in git) says why.
	const { url: plainUrl, project: plain } = await api(t);
	const other = await client(t, plainUrl);
	const unrecorded = (await other.request("conversations.create", { requestId: "plain", project: plain.dir })).conversation.id;
	const none = (await other.request("task.code", { conversationId: unrecorded })).changes;
	assert.equal(none.available, false);
	assert.equal(typeof none.reason, "string");
	await assert.rejects(other.request("task.code", { conversationId: unrecorded, path: "a.txt" }), { code: "not_found" });
});

/** A stand-in for Playwright's chromium: each "screenshot" is a PNG header followed by the page's HTML, as fetched. */
const FAKE_PLAYWRIGHT = `exports.chromium = {
	executablePath: () => process.execPath,
	launch: async () => ({
		close: async () => {},
		newContext: async () => ({
			newPage: async () => {
				let html = "";
				return {
					goto: async (url) => { const r = await fetch(url); html = await r.text(); return { status: () => r.status }; },
					waitForLoadState: async () => {},
					waitForTimeout: async () => {},
					screenshot: async ({ path }) => require("node:fs").writeFileSync(path, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from(html)])),
					close: async () => {},
				};
			},
		}),
	}),
};
`;

/** A free TCP port on this machine. */
async function freePort(): Promise<number> {
	const { createServer } = await import("node:net");
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	await new Promise((resolve) => server.close(resolve));
	return port;
}

test("a sandbox task's screenshots: before at base and after at HEAD, each in a worktree, served by task.shot", async (t) => {
	const { url, host, project, fake } = await sandboxApi(t);
	const port = await freePort();
	// The dev server serves a.txt as the page, so before and after differ; routes/notes.tsx is a changed route.
	writeFileSync(join(project.dir, "server.mjs"), `import { createServer } from "node:http";\nimport { existsSync, readFileSync } from "node:fs";\ncreateServer((q, s) => q.url === "/" || (q.url === "/notes" && existsSync("src/routes/notes.tsx")) ? s.end("<p>" + q.url + " " + readFileSync("a.txt", "utf8") + "</p>") : (s.statusCode = 404, s.end())).listen(Number(process.env.PORT), "127.0.0.1");\n`);
	writeFileSync(join(project.dir, ".gitignore"), "node_modules\n");
	mkdirSync(join(project.dir, ".agents"), { recursive: true });
	writeFileSync(join(project.dir, ".agents", "project.json"), JSON.stringify({ devServer: { command: "node server.mjs", port }, pages: [{ path: "/", label: "Home" }, "/missing"] }));
	git(project.dir, "add", "-A");
	git(project.dir, "commit", "-q", "-m", "serve");
	const mac = await client(t, url);
	const id = (await mac.request("conversations.create", { requestId: "s", project: project.dir, text: "report notes", sandbox: true })).conversation.id;
	await host.sandboxes.prepared(id);
	const box = fake.made[0]!.dir;
	// The project's Playwright, as its .agents/setup would install it; ignored, so the worktrees get it from here.
	mkdirSync(join(box, "node_modules", "playwright"), { recursive: true });
	writeFileSync(join(box, "node_modules", "playwright", "index.js"), FAKE_PLAYWRIGHT);
	writeFileSync(join(box, "node_modules", "playwright", "package.json"), JSON.stringify({ name: "playwright", main: "index.js" }));
	await waitFor(async () => (await host.sessions.states()).get(id) === "idle" && git(box, "log", "-1", "--format=%s") === "notes", "the run");
	// A route the turn changes is shot too.
	mkdirSync(join(box, "src", "routes"), { recursive: true });
	writeFileSync(join(box, "src", "routes", "notes.tsx"), "export {}\n");
	git(box, "add", "src");
	git(box, "commit", "-q", "-m", "route");
	const status = git(box, "status", "--porcelain");
	await host.results.afterRun(id);

	const result = (await mac.request("task.result", { conversationId: id })).result;
	// /missing answers 404 on both sides, so it's left out; /notes doesn't exist at base, so it has only an after.
	assert.deepEqual(result.shots.map((s: Json) => [s.side, s.label, s.path]), [["after", "Home", "/"], ["after", "/notes", "/notes"], ["before", "Home", "/"]]);
	assert.deepEqual(result.checks, [{ name: "pnpm test", ok: true }], "no declared checks, so the turn's own");
	const shot = async (s: Json) => Buffer.from((await mac.request("task.shot", { conversationId: id, shot: s.id })).data, "base64").toString();
	const after = await mac.request("task.shot", { conversationId: id, shot: result.shots[0].id });
	assert.equal(after.mimeType, "image/png");
	assert.match(await shot(result.shots[0]), /<p>\/ one\nmore\n<\/p>/);
	assert.match(await shot(result.shots[2]), /<p>\/ one\n<\/p>/);
	await assert.rejects(mac.request("task.shot", { conversationId: id, shot: "nope" }), { code: "not_found" });
	await assert.rejects(mac.request("task.shot", { conversationId: id, shot: "../x" }), { code: "not_found" });

	// The agent's files are as they were, the worktrees are gone, and the server was stopped.
	assert.equal(git(box, "status", "--porcelain"), status);
	assert.equal(git(box, "worktree", "list").split("\n").length, 1);
	await assert.rejects(fetch(`http://127.0.0.1:${port}/`));
	assert.ok(readdirSync(join(host.uploads, "..", "shots", String(id))).length === 3);

	// Once per answer: running it again takes none anew.
	await host.results.afterRun(id);
	assert.deepEqual((await mac.request("task.result", { conversationId: id })).result.shots, result.shots);
});

test("without a browser in the sandbox, a project with a dev server has no screenshots and says nothing", async (t) => {
	const { url, host, project, fake } = await sandboxApi(t);
	mkdirSync(join(project.dir, ".agents"), { recursive: true });
	writeFileSync(join(project.dir, ".agents", "project.json"), JSON.stringify({ checks: ["true"], devServer: { command: "sleep 30", port: await freePort() } }));
	git(project.dir, "add", "-A");
	git(project.dir, "commit", "-q", "-m", "serve");
	const mac = await client(t, url);
	const id = (await mac.request("conversations.create", { requestId: "s", project: project.dir, text: "report notes", sandbox: true })).conversation.id;
	await host.sandboxes.prepared(id);
	const box = fake.made[0]!.dir;
	await waitFor(async () => (await host.sessions.states()).get(id) === "idle" && git(box, "log", "-1", "--format=%s") === "notes", "the run");
	await host.results.afterRun(id);
	const result = (await mac.request("task.result", { conversationId: id })).result;
	assert.deepEqual(result.shots, []);
	assert.deepEqual(result.checks, [{ name: "true", ok: true }]);
	assert.equal(result.headsUp.length, 1, "only the agent's own heads-up");
});

test("host.info carries each project's checkout, and host.watch sends host.projects when one changes", async (t) => {
	const { url, project } = await sandboxApi(t);
	const mac = await client(t, url);
	const info = await mac.request("host.info");
	assert.deepEqual(info.projects.find((p: Json) => p.dir === project.dir).checkout, { branch: "main", dirty: 0, ahead: 0, behind: 0, upstream: "origin/main", sandboxes: true, checks: 0, code: false });
	const list = (await mac.request("host.watch")).subscription;
	await mac.event(list, type("host.snapshot"), "the host snapshot");
	writeFileSync(join(project.dir, "wip.txt"), "x\n");
	const seen = await mac.event(list, type("host.projects"), "host.projects");
	assert.equal(seen.find(type("host.projects")).projects.find((p: Json) => p.dir === project.dir).checkout.dirty, 1);
});

test("a sandbox session runs git push without asking by default, and one made with approvals ask waits", async (t) => {
	const { url, host, project } = await sandboxApi(t);
	const mac = await client(t, url);
	assert.equal((await mac.request("host.info")).sandboxes.approvals, "off");

	const off = (await mac.request("conversations.create", { requestId: "off", project: project.dir, text: "push it", sandbox: true })).conversation.id;
	await host.sandboxes.prepared(off);
	await waitFor(async () => /The push call ran/.test(JSON.stringify((await mac.request("conversation.history", { conversationId: off })).items)), "the push to run unasked");
	assert.deepEqual((await host.approvals.all()).filter((r) => r.conversationId === off), []);
	assert.equal((await mac.request("conversations.list")).conversations.find((c: Json) => c.id === off).sandbox.approvals, "off");

	const ask = (await mac.request("conversations.create", { requestId: "ask", project: project.dir, text: "push it", sandbox: true, approvals: "ask" })).conversation;
	assert.equal(ask.sandbox.approvals, "ask");
	await host.sandboxes.prepared(ask.id);
	await waitFor(async () => (await host.approvals.pending()).some((r) => r.conversationId === ask.id && r.summary === "git push"), "the push to wait");
	await host.stop(ask.id);
});

test("projects.create makes a project with its repository, lists it with its checkout, and host.info says where they go", async (t) => {
	const dir = tempDir(t);
	const root = join(dir, "Projects", "Software");
	const signedIn = fakeGh(join(dir, "github"));
	const { url } = await api(t, { dir, settings: { newProjects: { root, owner: "t" } }, newProjects: signedIn });
	const mac = await client(t, url);
	assert.deepEqual((await mac.request("host.info")).newProjects, { root, owner: "t" });
	const list = (await mac.request("host.watch")).subscription;
	await mac.event(list, type("host.snapshot"), "the host snapshot");

	const { project } = await mac.request("projects.create", { name: "waygate", description: "Gates." });
	assert.equal(project.dir, join(root, "waygate"));
	assert.equal(project.name, "waygate");
	assert.deepEqual(project.checkout, { branch: "main", dirty: 0, ahead: 0, behind: 0, upstream: "origin/main", sandboxes: { reason: "this host has no sandbox host" }, checks: 0, code: false });
	const listed = (await mac.event(list, (e) => e.type === "host.projects" && e.projects.some((p: Json) => p.name === "waygate"), "host.projects")).findLast(type("host.projects"));
	assert.ok(listed.projects.some((p: Json) => p.dir === project.dir));
	await assert.rejects(mac.request("projects.create", { name: "waygate" }), { code: "bad_request", message: /already exists/ });
	await assert.rejects(mac.request("projects.create", { name: "Way Gate" }), { code: "bad_request" });
});

test("a host whose gh isn't signed in has no newProjects, and refuses projects.create saying why", async (t) => {
	const dir = tempDir(t);
	const { url } = await api(t, { dir, settings: { newProjects: { root: join(dir, "Projects", "Software"), owner: "t" } }, newProjects: fakeGh(join(dir, "github"), { signedIn: false }) });
	const mac = await client(t, url);
	assert.equal((await mac.request("host.info")).newProjects, undefined);
	await assert.rejects(mac.request("projects.create", { name: "x" }), { code: "bad_request", message: /token for github.com is invalid/ });
});

test("a sandbox with no project is scratch: its work comes home to a repository of its own, and it can't ship", async (t) => {
	const { url, host, fake } = await sandboxApi(t);
	const mac = await client(t, url);
	const created = (await mac.request("conversations.create", { requestId: "scratch", text: "commit idea", sandbox: true })).conversation;
	assert.equal(created.project, undefined);
	assert.equal(created.sandbox.state, "preparing");
	const id = created.id;
	await host.sandboxes.prepared(id);
	const record = (await host.sessions.get(id))!;
	assert.equal(record.scratch, true);
	assert.equal(record.source, join(host.scratchRoot, String(id)));
	// The sandbox is a clone of one empty commit on main, the same for every scratch session.
	const box = fake.made[0]!.dir;
	await waitFor(async () => (await host.sessions.states()).get(id) === "idle" && git(box, "log", "-1", "--format=%s") === "idea", "the commit");
	assert.deepEqual(git(box, "log", "--format=%s").split("\n"), ["idea", "Scratch"]);
	assert.equal(record.sandboxBase, git(record.source!, "rev-parse", "main"));
	const other = (await mac.request("conversations.create", { requestId: "scratch-2", text: "hello", sandbox: true })).conversation.id;
	await host.sandboxes.prepared(other);
	assert.equal((await host.sessions.get(other))!.sandboxBase, record.sandboxBase, "one template for all scratch work");

	const synced = await mac.request("sandbox.sync", { conversationId: id });
	assert.equal(synced.commits, 1);
	assert.equal(git(record.source!, "log", "-1", "--format=%s", synced.branch), "idea");
	const code = await mac.request("task.code", { conversationId: id });
	assert.deepEqual(code.changes.files.map((f: Json) => f.path), ["idea.txt"]);
	await assert.rejects(mac.request("sandbox.ship", { conversationId: id }), { code: "bad_request", message: /no upstream/ });
});

test("sandbox.promote makes a scratch sandbox's work a new project, and the session that project's task, so it ships", async (t) => {
	const { url, host, fake } = await sandboxApi(t);
	const mac = await client(t, url);
	const id = (await mac.request("conversations.create", { requestId: "p", text: "commit idea", sandbox: true })).conversation.id;
	await host.sandboxes.prepared(id);
	const box = fake.made[0]!.dir;
	await waitFor(async () => (await host.sessions.states()).get(id) === "idle" && git(box, "log", "-1", "--format=%s") === "idea", "the commit");
	await assert.rejects(mac.request("sandbox.promote", { conversationId: id, name: "Bad Name" }), { code: "bad_request" });

	const { project } = await mac.request("sandbox.promote", { conversationId: id, name: "idea", description: "An idea." });
	assert.equal(project.name, "idea");
	assert.deepEqual(git(project.dir, "log", "--format=%s", "main").split("\n"), ["idea", "Scratch"]);
	assert.equal(git(project.dir, "rev-parse", "main"), git(box, "rev-parse", "HEAD"));
	assert.equal(project.checkout.upstream, "origin/main");
	const record = (await host.sessions.get(id))!;
	assert.equal(record.project, "idea");
	assert.equal(record.source, project.dir);
	assert.equal(record.scratch, undefined);
	assert.equal(record.sandboxBase, git(project.dir, "rev-parse", "main"));
	await waitFor(async () => (await mac.request("conversations.list")).conversations.find((c: Json) => c.id === id).project === "idea", "the summary to name the project");
	await assert.rejects(mac.request("sandbox.promote", { conversationId: id, name: "again" }), { code: "bad_request", message: /isn't a scratch sandbox/ });

	// More work, then a ship lands it on the new project's origin/main.
	await mac.request("submit", { conversationId: id, requestId: "more", text: "commit more" });
	await waitFor(async () => (await host.sessions.states()).get(id) === "idle" && git(box, "log", "-1", "--format=%s") === "more", "the second commit");
	const result = await (await host.ships.start(id, { mode: "main" })).done;
	assert.equal(result.shipped, true, result.shipped ? "" : result.reason);
	assert.deepEqual(git(project.dir, "log", "--format=%s", "origin/main").split("\n"), ["more", "idea", "Scratch"]);
});

test("a sandbox's size is its own, else its project's from .agents/project.json, else small, and the summary carries it", async (t) => {
	const { url, host, project, fake } = await sandboxApi(t);
	const mac = await client(t, url);
	await assert.rejects(mac.request("conversations.create", { requestId: "s0", project: project.dir, text: "x", sandbox: true, size: "huge" }), { code: "bad_request" });
	await assert.rejects(mac.request("conversations.create", { requestId: "s1", project: project.dir, text: "x", size: "large" }), { code: "bad_request" });
	const plain = (await mac.request("conversations.create", { requestId: "s2", project: project.dir, sandbox: true })).conversation.id;
	await host.sandboxes.prepared(plain);
	mkdirSync(join(project.dir, ".agents"));
	writeFileSync(join(project.dir, ".agents", "project.json"), JSON.stringify({ size: "medium" }));
	git(project.dir, "add", ".agents");
	git(project.dir, "commit", "-q", "-m", "bigger");
	const theirs = (await mac.request("conversations.create", { requestId: "s3", project: project.dir, sandbox: true })).conversation.id;
	await host.sandboxes.prepared(theirs);
	const own = (await mac.request("conversations.create", { requestId: "s4", project: project.dir, sandbox: true, size: "large" })).conversation.id;
	await host.sandboxes.prepared(own);
	assert.deepEqual(fake.sizes, ["small", "medium", "large"]);
	await waitFor(async () => {
		const all = (await mac.request("conversations.list")).conversations;
		return JSON.stringify([plain, theirs, own].map((id) => all.find((c: Json) => c.id === id).sandbox.size)) === '["small","medium","large"]';
	}, "the summaries' sizes");
});
