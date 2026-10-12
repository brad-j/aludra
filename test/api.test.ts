import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, type FauxResponseStep, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { WebSocket } from "ws";
import { createApi, inlineScriptHashes } from "../src/api.ts";
import type { Item, ServerEvent, SessionMeta, SessionSummary } from "../src/api-types.ts";
import { makeProject, tempDir, testHost } from "./helpers.ts";

const USER = "brad@example.com";

/** A host with a faux model answering `responses`, and its API on a free port. */
async function api(t: TestContext, responses: FauxResponseStep[], appDir?: string) {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", name: "Faux 1", contextWindow: 200_000 }, { id: "faux-2", name: "Faux 2" }] });
	faux.setResponses(responses);
	const models = createModels();
	models.setProvider(faux.provider);
	const { host, dir } = await testHost(t, { models, model: { provider: "faux", modelId: "faux-1" }, approvalHosts: ["think-1"] });
	const project = makeProject(dir, "one");
	const server = createApi(host, { user: USER, appDir: appDir ?? join(dir, "no-app") });
	await new Promise<void>((resolve) => server.listen(0, resolve));
	t.after(() => server.close());
	const base = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;
	const call = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
		fetch(base + path, {
			method: body === undefined ? "GET" : "POST",
			headers: { "tailscale-user-login": USER, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	return { host, project, base, call, faux };
}

/** A WebSocket client that keeps the latest sessions list and the followed session's transcript and meta. */
async function live(t: TestContext, base: string) {
	const ws = new WebSocket(`${base.replace("http", "ws")}/api/live`, { headers: { "tailscale-user-login": USER } });
	t.after(() => ws.close());
	const state = { sessions: [] as SessionSummary[], items: [] as Item[], meta: undefined as SessionMeta | undefined, events: [] as ServerEvent[] };
	const waiters = new Set<() => void>();
	ws.on("message", (data) => {
		const event = JSON.parse(String(data)) as ServerEvent;
		state.events.push(event);
		if (event.type === "sessions") state.sessions = event.sessions;
		if (event.type === "items") state.items = [...state.items.slice(0, event.start), ...event.items].slice(0, event.length);
		if (event.type === "meta") state.meta = event.meta;
		for (const wake of waiters) wake();
	});
	await new Promise((resolve, reject) => ws.once("open", resolve).once("error", reject));
	return {
		state,
		follow: (session: number | null) => {
			state.items = [];
			state.meta = undefined;
			ws.send(JSON.stringify({ type: "follow", session }));
		},
		/** Resolves once `check` holds, failing after 5 s with what was seen. */
		until: (check: () => boolean, what: string) =>
			new Promise<void>((resolve, reject) => {
				if (check()) return resolve();
				const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}: ${JSON.stringify({ items: state.items, meta: state.meta }).slice(0, 1500)}`)), 5000);
				const wake = () => {
					if (!check()) return;
					clearTimeout(timer);
					waiters.delete(wake);
					resolve();
				};
				waiters.add(wake);
			}),
	};
}

const toolThenAnswer = (command: string, answer: string): FauxResponseStep[] => [
	fauxAssistantMessage([fauxText("Looking."), fauxToolCall("bash", { command })], { stopReason: "toolUse" }),
	(ctx: TranscriptContext) => fauxAssistantMessage(`${answer} ${JSON.stringify(ctx.messages.at(-1)!.content)}`),
];

test("only Brad's Tailscale login gets in, and posts must be same-origin JSON", async (t) => {
	const { base, call } = await api(t, []);
	assert.equal((await fetch(`${base}/api/bootstrap`)).status, 403);
	assert.equal((await call("/api/bootstrap", undefined, { "tailscale-user-login": "someone@example.com" })).status, 403);
	assert.equal((await call("/api/sessions", { project: "one", text: "hi" }, { origin: "https://evil.example" })).status, 403);
	const form = await fetch(`${base}/api/sessions`, { method: "POST", headers: { "tailscale-user-login": USER, "content-type": "text/plain" }, body: "{}" });
	assert.equal(form.status, 403);
	const ws = new WebSocket(`${base.replace("http", "ws")}/api/live`);
	await assert.rejects(new Promise((resolve, reject) => ws.once("open", resolve).once("error", reject)), /403/);
});

test("bootstrap lists the projects, the models and the defaults", async (t) => {
	const { call } = await api(t, []);
	const boot = await (await call("/api/bootstrap")).json();
	assert.equal(boot.user, USER);
	assert.deepEqual(boot.projects.map((p: { name: string }) => p.name), ["one"]);
	assert.deepEqual(boot.models, [{ provider: "faux", id: "faux-1", name: "Faux 1" }]);
	assert.equal(boot.defaults.model.id, "faux-1");
	assert.ok(boot.thinking.includes("high"));
});

test("a new session runs, and the socket shows its list row, its calls and its answer", async (t) => {
	const { call, base } = await api(t, toolThenAnswer("echo hello", "Done:"));
	const client = await live(t, base);
	const created = await call("/api/sessions", { project: "one", text: "Say hello\nplease" });
	assert.equal(created.status, 200);
	const { id } = await created.json();
	client.follow(id);
	await client.until(() => client.state.meta?.summary.state === "done", "the run to finish");
	const kinds = client.state.items.map((i) => i.kind);
	assert.deepEqual(kinds, ["user", "answer", "call", "answer"]);
	const shell = client.state.items[2]!;
	assert.equal(shell.kind === "call" && shell.status, "done");
	assert.match(shell.kind === "call" ? shell.output ?? "" : "", /hello/);
	assert.match(client.state.items[3]!.kind === "answer" ? (client.state.items[3] as { text: string }).text : "", /^Done:/);
	await client.until(() => client.state.sessions.some((s) => s.id === id && s.state === "done"), "the list to show it done");
	const row = client.state.sessions.find((s) => s.id === id)!;
	assert.equal(row.title, "Say hello");
	assert.equal(row.project, "one");
	assert.match(row.line, /^Done:/);
	assert.equal(client.state.meta!.model.name, "Faux 1");
	assert.equal(client.state.meta!.context.window, 200_000);
	// Following again sends the whole transcript, and nothing changes in between.
	client.follow(id);
	await client.until(() => client.state.items.length === 4, "the transcript again");
});

test("a message sent while it runs waits in the queue, can be withdrawn, and stop ends the run", async (t) => {
	const { call, base } = await api(t, [fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 30" }), { stopReason: "toolUse" }), fauxAssistantMessage("unused")]);
	const client = await live(t, base);
	const { id } = await (await call("/api/sessions", { project: "one", text: "sleep" })).json();
	client.follow(id);
	await client.until(() => client.state.items.some((i) => i.kind === "call" && i.status === "running"), "the call to run");
	assert.equal(client.state.meta!.summary.state, "running");
	const { submission } = await (await call(`/api/sessions/${id}/messages`, { text: "then the docs", mode: "followUp" })).json();
	await client.until(() => client.state.meta?.queued.length === 1, "the follow-up to queue");
	assert.deepEqual(client.state.meta!.queued, [{ id: submission, mode: "followUp", text: "then the docs" }]);
	assert.deepEqual(await (await call(`/api/sessions/${id}/withdraw`, { submission })).json(), { result: "aborted" });
	await client.until(() => client.state.meta?.queued.length === 0, "the queue to empty");
	assert.equal((await call(`/api/sessions/${id}/stop`, {})).status, 200);
	await client.until(() => client.state.meta?.summary.state === "stopped", "the run to stop");
	assert.equal(client.state.items.at(-1)!.kind, "failure");
});

test("the model and thinking change per session; an unknown model is refused", async (t) => {
	const { call, base, host } = await api(t, [fauxAssistantMessage("ok")]);
	const client = await live(t, base);
	const { id } = await (await call("/api/sessions", { project: "one", text: "hi", thinking: "low" })).json();
	client.follow(id);
	await client.until(() => client.state.meta?.thinking === "low", "low thinking");
	assert.equal((await call(`/api/sessions/${id}/agent`, { thinking: "xhigh" })).status, 200);
	await client.until(() => client.state.meta?.thinking === "xhigh", "the new thinking");
	const refused = await call(`/api/sessions/${id}/agent`, { model: "faux-2" });
	assert.equal(refused.status, 404);
	assert.match(await refused.text(), /no model faux-2/);
	assert.equal((await (await host.conversation(id)).agent(undefined as never)).thinkingLevel, "xhigh");
});

test("an approval shows in the session's meta and is answered over the API", async (t) => {
	const { call, base } = await api(t, toolThenAnswer("ssh think-1 uptime || true", "Result:"));
	const client = await live(t, base);
	const { id } = await (await call("/api/sessions", { project: "one", text: "uptime on think-1" })).json();
	client.follow(id);
	await client.until(() => client.state.meta?.approval !== undefined, "the approval");
	assert.equal(client.state.meta!.summary.state, "waiting");
	await client.until(() => client.state.sessions.some((s) => s.id === id && s.state === "waiting"), "the list to show it waiting");
	const { approval } = client.state.meta!;
	assert.equal(approval!.summary, "ssh to think-1");
	assert.deepEqual(await (await call(`/api/approvals/${approval!.id}`, { allow: false })).json(), { status: "denied" });
	await client.until(() => client.state.meta?.summary.state === "done", "the run to finish");
	assert.equal((await call(`/api/approvals/${approval!.id}`, { allow: true })).status, 409);
});

test("the app is served from its build: files as they are, other pages get the shell, its inline scripts allowed by hash", async (t) => {
	const appDir = tempDir(t);
	const script = "window.__boot = 1;";
	writeFileSync(join(appDir, "_shell.html"), `<!doctype html><html><head><script>${script}</script><script src="/assets/app-1.js"></script></head></html>`);
	mkdirSync(join(appDir, "assets"));
	writeFileSync(join(appDir, "assets", "app-1.js"), "console.log(1)");
	const { call } = await api(t, [], appDir);
	const page = await call("/s/7");
	assert.equal(page.status, 200);
	assert.match(await page.text(), /__boot/);
	assert.ok(page.headers.get("content-security-policy")!.includes(`'sha256-${inlineScriptHashes(`<script>${script}</script>`)[0]}'`));
	const asset = await call("/assets/app-1.js");
	assert.equal(asset.headers.get("content-type"), "text/javascript; charset=utf-8");
	assert.match(asset.headers.get("cache-control")!, /immutable/);
	assert.equal((await call("/../package.json")).status, 200, "a path out of the build gets the shell, not the file");
	assert.doesNotMatch(await (await call("/%2e%2e/package.json")).text(), /"name": "aludra"/);
	assert.equal((await call("/api/nothing")).status, 404);
});
