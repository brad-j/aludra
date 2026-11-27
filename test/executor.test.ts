// Executor (src/executor.ts) against a stand-in on 127.0.0.1 (test/executor-stub.ts): sign-in from /app, coming back
// through the host's own API, the grant on disk, the tools in a no-project session and in no other, an approval link,
// refresh after a 401, and sign-out. Nothing reaches executor.sh.
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { WebSocket } from "ws";
import { createApi } from "../src/api.ts";
import type { Json } from "../src/app/translate.ts";
import { EXECUTOR_AUTH_FILE, executorDetails, toolName, toolParameters } from "../src/executor.ts";
import { type ExecutorStub, startExecutorStub } from "./executor-stub.ts";
import { makeProject, testHost } from "./helpers.ts";

const USER = "you@example.com";
/** The host's name on the tailnet, as tailscale serve passes it on. */
const TAILNET = "aludra.example.ts.net";

test("tool names get the prefix; schemas become objects with properties, or open objects when they can't validate", () => {
	assert.equal(toolName("search"), "executor_search");
	assert.equal(toolName("a.b/c"), "executor_a_b_c");
	assert.deepEqual(toolParameters({ type: "object" }), { type: "object", properties: {} });
	const withRefs = toolParameters({ type: "object", properties: { a: { $ref: "#/$defs/a" } }, $defs: { a: { type: "string" } } });
	assert.equal((withRefs.properties as Record<string, unknown>).a !== undefined, true);
	assert.deepEqual(toolParameters({ type: "object", properties: { a: { $ref: "#/nowhere" } } }), { type: "object", properties: {}, additionalProperties: true });
	assert.equal(toolParameters({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: {} }).$schema, undefined);
});

test("an approval link is kept only on Executor's site", () => {
	const result = (approvalUrl: string) => ({ content: [], structuredContent: { status: "approval-required", approvalUrl } });
	assert.equal(executorDetails("https://mcp.executor.sh/mcp", "call", result("https://app.executor.sh/approve/1")).approvalUrl, "https://app.executor.sh/approve/1");
	assert.equal(executorDetails("https://mcp.executor.sh/mcp", "call", result("https://evil.example/approve")).approvalUrl, undefined);
	assert.equal(executorDetails("https://mcp.executor.sh/mcp", "call", result("http://app.executor.sh/approve")).approvalUrl, undefined);
	assert.equal(executorDetails("https://mcp.executor.sh/mcp", "call", result("javascript:alert(1)")).approvalUrl, undefined);
});

async function until<T>(check: () => T | undefined | Promise<T | undefined>, what: string, ms = 10_000): Promise<T> {
	const end = Date.now() + ms;
	for (;;) {
		const found = await check();
		if (found !== undefined && found !== false) return found;
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 30));
	}
}

/**
 * A faux host whose Executor is a stand-in, with its API on a free port and an /app client that came in through the
 * tailnet name. "tools?" answers with the tools offered; "executor: PATH" calls executor_call with that path.
 */
async function executorHost(t: TestContext, stub: ExecutorStub, dir?: string) {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	faux.setResponses(Array.from({ length: 30 }, () => (ctx: TranscriptContext) => {
		const last = ctx.messages.findLast((m) => m.role !== "system");
		if (last?.role === "toolResult") return fauxAssistantMessage(fauxText(`${last.toolName} returned: ${JSON.stringify(last.content)}`));
		const user = JSON.stringify(last?.content ?? "");
		const system = ctx.messages.filter((m) => m.role === "system") as unknown as { toolsAdded?: { name: string }[]; toolsRemoved?: (string | { name: string })[] }[];
		const offered = new Set<string>();
		for (const m of system) {
			for (const tool of m.toolsRemoved ?? []) offered.delete(typeof tool === "string" ? tool : tool.name);
			for (const tool of m.toolsAdded ?? []) offered.add(tool.name);
		}
		if (/tools\?/.test(user)) return fauxAssistantMessage(fauxText(`Tools: ${[...offered].join(",")}`));
		const path = /executor: ([\w.]+)/.exec(user)?.[1];
		if (path !== undefined) return fauxAssistantMessage(fauxToolCall("executor_call", { calls: { path } }), { stopReason: "toolUse" });
		return fauxAssistantMessage(fauxText("ok"));
	}));
	const models = createModels();
	models.setProvider(faux.provider);
	const { host, dir: root, config } = await testHost(t, { models, model: { provider: "faux", modelId: "faux-1" }, executor: { url: stub.url }, ...(dir === undefined ? {} : { dir }) });
	const server = createApi(host, { users: [USER], name: "test-host" });
	await new Promise<void>((resolve) => server.listen(0, resolve));
	t.after(() => server.close());
	const port = (server.server.address() as AddressInfo).port;
	const ws = new WebSocket(`ws://127.0.0.1:${port}/app`, { headers: { "tailscale-user-login": USER, host: TAILNET } });
	t.after(() => ws.close());
	const responses = new Map<string, Json>();
	const events: Json[] = [];
	ws.on("message", (data) => {
		const frame = JSON.parse(String(data));
		if (frame.type === "response") responses.set(frame.id, frame);
		if (frame.type === "event") events.push(...frame.events);
	});
	await new Promise((resolve, reject) => ws.once("open", resolve).once("error", reject));
	ws.send(JSON.stringify({ type: "hello", protocols: [1], client: { name: "test", version: "0" } }));
	let next = 0;
	const request = async (method: string, params: Json = {}): Promise<Json> => {
		const id = `r${++next}`;
		ws.send(JSON.stringify({ type: "request", id, method, params }));
		const response = await until(() => responses.get(id), method);
		if (response.error !== undefined) throw Object.assign(new Error(response.error.message), { code: response.error.code });
		return response.result;
	};
	/** What a browser does with the sign-in page: the stand-in approves at once, and the redirect comes back to the host's API. */
	const browse = async (url: string) => {
		const res = await fetch(url, { redirect: "manual" });
		const back = new URL(res.headers.get("location")!);
		assert.equal(back.origin, `https://${TAILNET}`, "the redirect goes to the host's tailnet address");
		assert.equal(back.pathname, "/api/executor/callback");
		const done = await fetch(`http://127.0.0.1:${port}${back.pathname}${back.search}`, { headers: { "tailscale-user-login": USER } });
		return { status: done.status, text: await done.text(), back };
	};
	const texts = async (id: number) => {
		const entries = (await (await host.conversation(id)).entries({ order: "ascending" }, 500, undefined, BACKGROUND_CONTEXT)).items;
		return entries.flatMap((e) => (e.kind === "pi.assistant" ? (e.model ?? []).flatMap((m) => (m.role === "assistant" ? m.content : [])).flatMap((b) => (b.type === "text" ? [b.text] : [])) : []));
	};
	/** The first answer starting `start` after the session's first `after` text answers. */
	const answer = async (id: number, start: string, after = 0) =>
		until(async () => (await texts(id)).slice(after).find((s) => s.startsWith(start)), `an answer starting ${start}`, 5_000).catch(async (error) => {
			throw new Error(`${error.message}; saw ${JSON.stringify(await texts(id))}`);
		});
	const ask = async (id: number, text: string, start: string) => {
		const before = (await texts(id)).length;
		await host.submit(id, text, { requestId: `${id}:${text}:${Date.now()}` });
		return answer(id, start, before);
	};
	return { host, root, config, port, request, events, browse, ask };
}

test("signing in from /app comes back through the host's API, stores the grant owner-only, and only no-project sessions get the tools", async (t) => {
	const stub = await startExecutorStub();
	t.after(() => stub.close());
	const { host, root, config, port, request, events, browse, ask } = await executorHost(t, stub);
	assert.equal((await request("host.info")).executor.state, "signed_out");
	await request("host.watch");

	const { url } = await request("executor.signIn");
	assert.ok(url.startsWith(`${stub.origin}/authorize?`), url);
	assert.match(url, /code_challenge_method=S256/);
	assert.match(decodeURIComponent(url), new RegExp(`redirect_uri=https://${TAILNET}/api/executor/callback`));
	assert.equal((await request("executor.status")).status.signInUrl, url);

	const done = await browse(url);
	assert.equal(done.status, 200, done.text);
	assert.match(done.text, /Signed in/);
	// The same page loaded again, as a browser's reload or prefetch does, says it's done rather than to start over.
	const again = await fetch(`http://127.0.0.1:${port}${done.back.pathname}${done.back.search}`, { headers: { "tailscale-user-login": USER } });
	assert.equal(again.status, 200);
	assert.doesNotMatch(await again.text(), /No sign-in is waiting/);
	await until(() => events.find((e) => e.type === "executor.changed" && e.status.state === "ok"), "executor.changed with ok");
	const status = (await request("executor.status")).status;
	assert.deepEqual(status.tools, ["skills", "search", "describe", "call", "execute", "resume"]);
	assert.equal(status.signInUrl, undefined);

	const file = join(config.dataDir, EXECUTOR_AUTH_FILE);
	assert.equal(statSync(file).mode & 0o777, 0o600);
	const grant = JSON.parse(readFileSync(file, "utf8"));
	assert.ok(grant.tokens.access_token && grant.tokens.refresh_token);
	assert.ok(!JSON.stringify(events).includes(grant.tokens.access_token), "the grant never reaches a client");

	// A no-project session has the tools, and an approval comes back as a link; a project session has none.
	const scratch = await host.sessions.createScratch("x");
	assert.match(await ask(scratch.id, "tools?", "Tools:"), /executor_call/);
	assert.match(await ask(scratch.id, "executor: gmail.send", "executor_call returned:"), /approval-required/);
	const entries = (await (await host.conversation(scratch.id)).entries({}, 200, undefined, BACKGROUND_CONTEXT)).items;
	const result = entries.flatMap((e) => (e.kind === "pi.tool-result" ? e.model ?? [] : [])).find((m) => m.role === "toolResult" && m.toolName === "executor_call");
	assert.deepEqual((result as { details?: unknown } | undefined)?.details, { tool: "executor", name: "call", status: "approval-required", approvalUrl: `${stub.origin}/approve/req_1` });
	const project = await host.sessions.create(makeProject(root, "demo"), "x");
	assert.doesNotMatch(await ask(project.id, "tools?", "Tools:"), /executor_/);

	// A 401 refreshes the tokens and the call goes through.
	stub.expireTokens();
	assert.deepEqual((await host.executor.call("call", { calls: { path: "gmail.search" } })).structuredContent, { status: "completed", result: { ok: true, path: "gmail.search" } });
	assert.notEqual(JSON.parse(readFileSync(file, "utf8")).tokens.access_token, grant.tokens.access_token);

	// Signing out forgets the grant and takes the tools away.
	assert.equal((await request("executor.signOut")).status.state, "signed_out");
	assert.throws(() => statSync(file));
	assert.doesNotMatch(await ask(scratch.id, "tools?", "Tools:"), /executor_/);
});

test("the callback refuses a state no sign-in waits for, and a request without a listed login", async (t) => {
	const stub = await startExecutorStub();
	t.after(() => stub.close());
	const { port, request } = await executorHost(t, stub);
	const page = (query: string, login = true) => fetch(`http://127.0.0.1:${port}/api/executor/callback?${query}`, { headers: login ? { "tailscale-user-login": USER } : {} });
	assert.equal((await page("code=x&state=y")).status, 400);
	await request("executor.signIn");
	assert.equal((await page("code=x&state=y")).status, 400);
	assert.equal((await page("code=x&state=y", false)).status, 403);
	assert.equal((await request("executor.status")).status.state, "signed_out");
});

test("a revoked grant signs out rather than opening a browser, and a restart connects with a stored grant", async (t) => {
	const stub = await startExecutorStub();
	t.after(() => stub.close());
	const first = await executorHost(t, stub);
	await first.browse((await first.request("executor.signIn")).url);
	await until(() => first.host.executor.status().state === "ok" || undefined, "signed in");
	stub.revoke();
	await assert.rejects(first.host.executor.call("search", {}), /sign in again/);
	assert.equal(first.host.executor.status().state, "signed_out");
	assert.equal(first.host.executor.status().signInUrl, undefined);

	await first.browse((await first.request("executor.signIn")).url);
	await until(() => first.host.executor.status().state === "ok" || undefined, "signed in again");
	await first.host.close();
	const second = await executorHost(t, stub, first.root);
	await until(() => second.host.executor.status().state === "ok" || undefined, "connected from the stored grant");
});
