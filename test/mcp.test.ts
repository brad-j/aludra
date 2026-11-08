import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createModels } from "@earendil-works/pi-ai/models";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, type FauxResponseStep, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createApi } from "../src/api.ts";
import { configFor } from "../src/config.ts";
import { context } from "../src/host.ts";
import { transcriptText } from "../src/mcp.ts";
import { fakeSandboxes, gitProject, makeProject, SANDBOX_SETTINGS, tempDir, testHost } from "./helpers.ts";

const USER = "you@example.com";

/** A faux host with its API on a free port and a read token and a write token for /mcp. `write` turns on mcp.write;
 * `connect` uses the write token unless given other headers. */
async function mcp(t: TestContext, write: boolean, options: { sandboxOnly?: boolean; sandboxes?: boolean; approvals?: "ask" | "off"; responses?: FauxResponseStep[] } = {}) {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }, { id: "faux-think", reasoning: true }] });
	faux.setResponses(options.responses ?? Array.from({ length: 20 }, () => fauxAssistantMessage(fauxText("The build passes now."))));
	const models = createModels();
	models.setProvider(faux.provider);
	const fake = options.sandboxes === true ? fakeSandboxes(tempDir(t)) : undefined;
	if (fake !== undefined) t.after(() => fake.close());
	const { host, dir, config } = await testHost(t, { models, model: { provider: "faux", modelId: "faux-1" }, ...(fake === undefined ? {} : { sandboxes: fake.sandboxes, settings: { sandboxes: { ...SANDBOX_SETTINGS.sandboxes, ...(options.approvals === undefined ? {} : { approvals: options.approvals }) } } }) });
	config.mcp.write = write;
	config.mcp.sandboxOnly = options.sandboxOnly === true;
	const project = fake === undefined ? makeProject(dir, "site") : gitProject(dir, "site").project;
	const server = createApi(host, { users: [USER], name: "egwene" });
	await new Promise<void>((resolve) => server.listen(0, resolve));
	t.after(() => server.close());
	const url = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;
	const reader = host.tokens.create("reader", "read");
	const writer = host.tokens.create("writer", "write");
	const bearer = (secret: string) => ({ authorization: `Bearer ${secret}` });
	const connect = async (headers: Record<string, string> = bearer(writer.secret)) => {
		const client = new Client({ name: "test", version: "1" });
		await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers } }));
		t.after(() => client.close());
		return client;
	};
	return { host, project, url, connect, reader, writer, bearer };
}

const READ_TOOLS = ["check_sessions", "list_projects", "list_sessions", "mark_sessions_handled", "read_session", "search_messages"];
const WRITE_TOOLS = [...READ_TOOLS, "archive_session", "send_message", "start_session", "stop_session", "unarchive_session"].sort();

const text = (result: unknown) => ((result as { content: { text: string }[] }).content[0]!.text);

test("read-only: an agent lists projects and sessions, reads a transcript and searches, and has no tools to write", async (t) => {
	const { host, project, connect, writer } = await mcp(t, false);
	const session = await host.sessions.create(project, "Fix the build");
	await (await host.submit(session.id, "Fix the build")).wait(context);

	// A write token, but mcp.write is off.
	const client = await connect();
	assert.match(client.getInstructions() ?? "", /egwene.*read-only for you: the host's mcp.write setting is off/s);
	const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
	assert.deepEqual(tools, READ_TOOLS);
	assert.ok((await client.listTools()).tools.every((tool) => tool.annotations?.readOnlyHint === true || tool.name === "mark_sessions_handled"));

	assert.deepEqual(JSON.parse(text(await client.callTool({ name: "list_projects", arguments: {} }))).map((p: { name: string }) => p.name), ["site"]);
	const sessions = JSON.parse(text(await client.callTool({ name: "list_sessions", arguments: {} })));
	assert.deepEqual(sessions.map((s: { id: number; state: string }) => [s.id, s.state]), [[session.id, "done"]]);
	const transcript = text(await client.callTool({ name: "read_session", arguments: { id: session.id } }));
	assert.match(transcript, /^Session \d+: Fix the build\nProject: site .*\nState: done\nModel: faux-1\nEffort: high\n/);
	assert.match(transcript, /## User\nFix the build\n\n## Agent\nThe build passes now\./);
	const missing = await client.callTool({ name: "read_session", arguments: { id: 999 } });
	assert.equal(missing.isError, true);
	const found = JSON.parse(text(await client.callTool({ name: "search_messages", arguments: { query: "build passes" } })));
	assert.deepEqual(found.map((r: { session: number; from: string }) => [r.session, r.from]), [[session.id, "agent"]]);
	const refused = await client.callTool({ name: "start_session", arguments: { project: "site", task: "x" } });
	assert.equal(refused.isError, true);
	assert.match(text(refused), /start_session not found/);
	assert.equal((await host.sessions.list()).length, 1, "no session was started");
	assert.ok(host.tokens.list().find((tok) => tok.id === writer.token.id)?.lastSeenAt, "the token's use is noted");
});

test("a read token can't write even with mcp.write on", async (t) => {
	const { host, connect, reader, bearer } = await mcp(t, true);
	const client = await connect(bearer(reader.secret));
	assert.match(client.getInstructions() ?? "", /read-only for you: this token is read-only/);
	assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), READ_TOOLS);
	const refused = await client.callTool({ name: "start_session", arguments: { project: "site", task: "x" } });
	assert.equal(refused.isError, true);
	assert.equal((await host.sessions.list()).length, 0, "no session was started");
});

test("with a write token and mcp.write, an agent starts a session, messages it and stops it", async (t) => {
	const { host, connect } = await mcp(t, true);
	const client = await connect();
	assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), WRITE_TOOLS);
	const started = JSON.parse(text(await client.callTool({ name: "start_session", arguments: { project: "site", task: "Make the build pass\nIt fails on main." } })));
	assert.equal((await host.sessions.get(started.id))?.title, "Make the build pass");
	while ((await host.sessions.states()).get(started.id) !== "idle") await new Promise((resolve) => setTimeout(resolve, 10));
	assert.match(text(await client.callTool({ name: "send_message", arguments: { id: started.id, text: "And add a test" } })), /submission/);
	assert.match(text(await client.callTool({ name: "stop_session", arguments: { id: started.id } })), /stopped/);
	const wrong = await client.callTool({ name: "start_session", arguments: { project: "nope", task: "x" } });
	assert.equal(wrong.isError, true);
});


/** Waits until session `id` has finished its run. */
async function idle(host: Awaited<ReturnType<typeof mcp>>["host"], id: number) {
	while ((await host.sessions.states()).get(id) !== "idle") await new Promise((resolve) => setTimeout(resolve, 10));
}

test("sandboxOnly: start_session always makes a sandbox session and refuses to make a local one", async (t) => {
	const { host, connect } = await mcp(t, true, { sandboxOnly: true, sandboxes: true });
	const client = await connect();
	const tools = (await client.listTools()).tools;
	assert.deepEqual(tools.map((tool) => tool.name).sort(), WRITE_TOOLS, "no tool syncs, merges or ships");
	assert.match(client.getInstructions() ?? "", /in sandboxes only/);

	// No sandbox argument still gets a sandbox.
	const started = JSON.parse(text(await client.callTool({ name: "start_session", arguments: { project: "site", task: "Make the build pass" } })));
	assert.equal(typeof started.sandbox, "number");
	const record = await host.sessions.get(started.id);
	assert.ok(record?.sandbox !== undefined && record.sandboxNumber !== undefined, "it's a sandbox session");
	assert.ok(JSON.parse(text(await client.callTool({ name: "start_session", arguments: { project: "site", task: "Again", sandbox: true } }))).sandbox !== undefined);

	// Asking for a local one is refused, and nothing is made.
	const before = (await host.sessions.list()).length;
	const local = await client.callTool({ name: "start_session", arguments: { project: "site", task: "Run here", sandbox: false } });
	assert.equal(local.isError, true);
	assert.match(text(local), /only sandbox sessions \(mcp.sandboxOnly\)/);
	assert.equal((await host.sessions.list()).length, before, "no session was started");
	assert.ok((await host.sessions.list()).every((r) => r.sandboxNumber !== undefined), "every session is in a sandbox");
});

test("sandboxOnly: send_message and stop_session act on sandbox sessions and refuse local ones, the user's own too", async (t) => {
	const { host, project, connect } = await mcp(t, true, { sandboxOnly: true, sandboxes: true });
	const client = await connect();
	// Started by the user here, not over MCP.
	const mine = await host.sessions.create(project, "Mine");
	await (await host.submit(mine.id, "Mine")).wait(context);
	for (const call of [{ name: "send_message", arguments: { id: mine.id, text: "Delete everything" } }, { name: "send_message", arguments: { id: mine.id, text: "Now", mode: "steer" } }, { name: "stop_session", arguments: { id: mine.id } }]) {
		const refused = await client.callTool(call);
		assert.equal(refused.isError, true, call.name);
		assert.match(text(refused), new RegExp(`session ${mine.id} isn't in a sandbox`), call.name);
	}
	const transcript = text(await client.callTool({ name: "read_session", arguments: { id: mine.id } }));
	assert.doesNotMatch(transcript, /Delete everything/, "the message never reached it");
	assert.equal((await client.callTool({ name: "send_message", arguments: { id: 999, text: "x" } })).isError, true);

	// A sandbox session, the user's or one MCP started, takes both.
	const boxed = await host.sessions.createSandbox(project, "Boxed");
	await (await host.submit(boxed.id, "Boxed")).wait(context);
	await idle(host, boxed.id);
	assert.match(text(await client.callTool({ name: "send_message", arguments: { id: boxed.id, text: "And add a test" } })), /submission/);
	assert.match(text(await client.callTool({ name: "stop_session", arguments: { id: boxed.id } })), /stopped/);
});

test("sandboxOnly without a sandbox host: every write tool fails closed and nothing runs locally", async (t) => {
	const { host, project, connect } = await mcp(t, true, { sandboxOnly: true });
	const client = await connect();
	const mine = await host.sessions.create(project, "Mine");
	await (await host.submit(mine.id, "Mine")).wait(context);
	for (const call of [
		{ name: "start_session", arguments: { project: "site", task: "x" } },
		{ name: "start_session", arguments: { project: "site", task: "x", sandbox: true } },
		{ name: "start_session", arguments: { project: "site", task: "x", sandbox: false } },
		{ name: "send_message", arguments: { id: mine.id, text: "x" } },
		{ name: "stop_session", arguments: { id: mine.id } },
	]) {
		const refused = await client.callTool(call);
		assert.equal(refused.isError, true, JSON.stringify(call));
		assert.match(text(refused), /mcp.sandboxOnly is on but the settings name no sandbox host/, JSON.stringify(call));
	}
	assert.deepEqual((await host.sessions.list()).map((r) => r.id), [mine.id], "no session was started");
});

test("tool descriptions say sandbox-only when it's on, the same on every connection, and not when it's off", async (t) => {
	const describe = async (sandboxOnly: boolean) => {
		const { connect } = await mcp(t, true, { sandboxOnly, sandboxes: true });
		const list = async () => Object.fromEntries((await (await connect()).listTools()).tools.map((tool) => [tool.name, { description: tool.description, schema: tool.inputSchema }]));
		const first = await list();
		assert.deepEqual(await list(), first, "fixed between connections");
		return first;
	};
	const on = await describe(true);
	for (const name of ["start_session", "send_message", "stop_session"]) assert.match(on[name]!.description ?? "", /[Ss]andbox-only/, name);
	assert.match(JSON.stringify(on.start_session!.schema), /Sandbox-only here/);
	const off = await describe(false);
	for (const name of ["start_session", "send_message", "stop_session"]) assert.doesNotMatch(off[name]!.description ?? "", /[Ss]andbox-only/, name);
});

test("without sandboxOnly, write tools still act on local sessions", async (t) => {
	const { host, project, connect } = await mcp(t, true, { sandboxes: true });
	const client = await connect();
	const mine = await host.sessions.create(project, "Mine");
	await (await host.submit(mine.id, "Mine")).wait(context);
	await idle(host, mine.id);
	assert.match(text(await client.callTool({ name: "send_message", arguments: { id: mine.id, text: "More" } })), /submission/);
	const started = JSON.parse(text(await client.callTool({ name: "start_session", arguments: { project: "site", task: "Local", sandbox: false } })));
	assert.equal(started.sandbox, undefined);
	await idle(host, started.id);
});

test("only live tokens, not Tailscale logins, no browsers, and only POST", async (t) => {
	const { host, url, connect, reader, bearer } = await mcp(t, false);
	const post = (headers: Record<string, string>) => fetch(`${url}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });

	const none = await post({});
	assert.equal(none.status, 401);
	assert.equal(none.headers.get("www-authenticate"), "Bearer");
	assert.equal((await post(bearer("aludra_wrong"))).status, 401);
	// The API's login is no way in here, and a token works from a machine with none.
	assert.equal((await post({ "tailscale-user-login": USER })).status, 401);
	assert.equal((await post(bearer(reader.secret))).status, 200);

	assert.ok(host.tokens.revoke(reader.token.id));
	assert.equal((await post(bearer(reader.secret))).status, 401, "a revoked token stops at once");
	await assert.rejects(connect(bearer(reader.secret)), /401|Unauthorized|bearer/i);

	const fromPage = await post({ ...bearer(reader.secret), origin: "https://evil.example" });
	assert.equal(fromPage.status, 403);
	assert.equal((await fetch(`${url}/mcp`)).status, 405);
	const bad = await fetch(`${url}/mcp`, { method: "POST", headers: { ...bearer(host.tokens.create("other", "read").secret), "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{not json" });
	assert.equal(bad.status, 400);
});

test("the API still wants a listed Tailscale login, and a token isn't one", async (t) => {
	const { url, writer, bearer } = await mcp(t, false);
	assert.equal((await fetch(`${url}/api/bootstrap`, { headers: bearer(writer.secret) })).status, 403);
	assert.equal((await fetch(`${url}/api/bootstrap`, { headers: { "tailscale-user-login": USER } })).status, 200);
});

test("mcp.write and mcp.sandboxOnly come from the settings file and are off by default", () => {
	const workspaces = [{ name: "a", roots: [] }];
	assert.deepEqual(configFor(JSON.stringify({ workspaces }), {}).config.mcp, { write: false, sandboxOnly: false });
	assert.deepEqual(configFor(JSON.stringify({ workspaces, mcp: { write: true } }), {}).config.mcp, { write: true, sandboxOnly: false });
	assert.deepEqual(configFor(JSON.stringify({ workspaces, mcp: { write: true, sandboxOnly: true } }), {}).config.mcp, { write: true, sandboxOnly: true });
	assert.match(configFor(JSON.stringify({ workspaces, mcp: { sandboxOnly: "yes" } }), {}).errors.join("\n"), /sandboxOnly/);
});

test("a long transcript keeps its latest items", () => {
	const items = Array.from({ length: 100 }, (_, i) => ({ kind: "user" as const, id: String(i), text: `message ${i} ${"x".repeat(100)}`, at: i }));
	const shown = transcriptText(items, 2000);
	assert.match(shown, /^\(\d+ earlier items left out\)/);
	assert.match(shown, /message 99/);
	assert.doesNotMatch(shown, /message 0 /);
});

type Gate = { wake: boolean; topic: string; through?: number; data: { change: number; id: number; from: string | null; to: string; transition: string; title: string; project: string; updated: string; agent: string; question?: { text: string; options: string[] } }[] };
const check = async (client: Client): Promise<Gate> => JSON.parse(text(await client.callTool({ name: "check_sessions", arguments: {} })));

test("check_sessions wakes on a new session and on each run's end, and moves no cursor", async (t) => {
	const { host, project, connect, reader, bearer } = await mcp(t, false);
	const client = await connect(bearer(reader.secret));
	assert.deepEqual(await check(client), { wake: false, data: [], topic: "" }, "nothing yet");

	const session = await host.sessions.create(project, "Fix the build");
	await (await host.submit(session.id, "Fix the build")).wait(context);
	await idle(host, session.id);
	const first = await check(client);
	assert.equal(first.wake, true);
	assert.equal(first.data.length, 1);
	const [entry] = first.data;
	assert.equal(entry!.id, session.id);
	assert.equal(entry!.project, "site");
	assert.equal(entry!.from, null);
	assert.equal(entry!.to, "done");
	assert.equal(entry!.transition, "new → done");
	assert.equal(entry!.agent, "The build passes now.");
	assert.ok(!Number.isNaN(Date.parse(entry!.updated)));
	assert.match(first.topic, /^site #\d+ Fix the build: new → done$/);
	assert.equal(first.through, entry!.change);

	// Checking again, with nothing marked, gives the same changes.
	assert.deepEqual(await check(client), first, "check_sessions moves nothing");

	// Handled through it: nothing until the session changes again.
	assert.deepEqual(JSON.parse(text(await client.callTool({ name: "mark_sessions_handled", arguments: { through: first.through } }))), { through: first.through });
	assert.equal((await check(client)).wake, false);
	await (await host.submit(session.id, "Again")).wait(context);
	await idle(host, session.id);
	const second = await check(client);
	assert.equal(second.wake, true);
	assert.deepEqual(second.data.map((d) => d.transition), ["done → done"], "a newer run that ended done");
	assert.ok(second.through! > first.through!);
});

test("each token keeps its own cursor, so marking for one doesn't hide changes from another", async (t) => {
	const { host, project, connect, reader, writer, bearer } = await mcp(t, false);
	const lan = await connect(bearer(reader.secret));
	const loial = await connect(bearer(writer.secret));
	const a = await host.sessions.create(project, "One");
	await (await host.submit(a.id, "One")).wait(context);
	const b = await host.sessions.create(project, "Two");
	await (await host.submit(b.id, "Two")).wait(context);
	const seen = await check(lan);
	assert.deepEqual(seen.data.map((d) => d.id), [a.id, b.id], "oldest first");
	assert.match(seen.topic, /#\d+ Two: new → done \(\+1 more\)$/, "the newest change");

	// Marking through the first change only leaves the second.
	await lan.callTool({ name: "mark_sessions_handled", arguments: { through: seen.data[0]!.change } });
	assert.deepEqual((await check(lan)).data.map((d) => d.id), [b.id]);
	assert.deepEqual((await check(loial)).data.map((d) => d.id), [a.id, b.id], "the other token still has both");

	// Never back, never past the newest.
	await lan.callTool({ name: "mark_sessions_handled", arguments: { through: 0 } });
	assert.deepEqual((await check(lan)).data.map((d) => d.id), [b.id]);
	const marked = JSON.parse(text(await lan.callTool({ name: "mark_sessions_handled", arguments: { through: 1_000_000 } })));
	assert.equal(marked.through, seen.through);
	assert.equal((await check(lan)).wake, false);
	assert.equal((await check(loial)).wake, true);
});

/** Answers by what the last message asks: a push waits for approval, sleep runs until stopped, fail errors, and
 * question ends with a result block asking one. */
const SCRIPTED: FauxResponseStep[] = Array.from({ length: 40 }, () => (ctx: TranscriptContext) => {
	const last = ctx.messages.at(-1);
	if (last?.role === "toolResult") return fauxAssistantMessage(fauxText("Ran it."));
	const asked = JSON.stringify(last?.content ?? "");
	if (/push/.test(asked)) return fauxAssistantMessage(fauxToolCall("bash", { command: "git push --dry-run" }), { stopReason: "toolUse" });
	if (/sleep/.test(asked)) return fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 30" }), { stopReason: "toolUse" });
	if (/fail/.test(asked)) return fauxAssistantMessage("", { stopReason: "error", errorMessage: "rate limited" });
	if (/question/.test(asked)) return fauxAssistantMessage(fauxText('Which way?\n\n```result\n{"question": {"text": "Keep the old API?", "options": ["Keep it", "Drop it"]}}\n```'));
	return fauxAssistantMessage(fauxText("Done that.\nAll tests pass."));
});

async function until(test: () => Promise<boolean>, what: string) {
	const end = Date.now() + 10_000;
	while (!(await test())) {
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

test("check_sessions sees waiting, stopped, failed and asking sessions, and a new token only what changed after it was made", async (t) => {
	const { host, project, connect, bearer } = await mcp(t, false, { responses: SCRIPTED });
	const before = await host.sessions.create(project, "Before");
	await (await host.submit(before.id, "Before")).wait(context);
	await new Promise((resolve) => setTimeout(resolve, 5));
	const token = host.tokens.create("lan", "read");
	const client = await connect(bearer(token.secret));
	assert.equal((await check(client)).wake, false, "the session done before the token was made");

	const pushing = await host.sessions.create(project, "Push it");
	void host.submit(pushing.id, "push it");
	await until(async () => (await host.approvals.pending()).some((r) => r.conversationId === pushing.id), "the approval");
	const waiting = await check(client);
	assert.deepEqual(waiting.data.map((d) => d.transition), ["new → waiting"]);
	await client.callTool({ name: "mark_sessions_handled", arguments: { through: waiting.through } });

	const sleeping = await host.sessions.create(project, "Sleep");
	void host.submit(sleeping.id, "sleep");
	await until(async () => (await host.sessions.states()).get(sleeping.id) === "running", "the run");
	const started = await check(client);
	assert.deepEqual(started.data.map((d) => d.transition), ["new → running"], "a new session wakes, running or not");
	await client.callTool({ name: "mark_sessions_handled", arguments: { through: started.through } });
	assert.equal((await check(client)).wake, false, "running on its own wakes nothing");
	await host.stop(sleeping.id);
	await idle(host, sleeping.id);
	const failing = await host.sessions.create(project, "Fail");
	await (await host.submit(failing.id, "fail")).wait(context);
	const asking = await host.sessions.create(project, "Ask");
	await (await host.submit(asking.id, "question")).wait(context);
	await until(async () => (await host.sessions.states()).get(asking.id) === "idle", "the answer");

	const changes = await check(client);
	const by = new Map(changes.data.map((d) => [d.id, d]));
	assert.equal(by.get(sleeping.id)?.transition, "running → stopped");
	assert.equal(by.get(failing.id)?.transition, "new → failed");
	assert.equal(by.get(asking.id)?.transition, "new → done");
	assert.equal(by.get(asking.id)?.agent, "Which way?", "the last prose line, not the result block");
	assert.deepEqual(by.get(asking.id)?.question, { text: "Keep the old API?", options: ["Keep it", "Drop it"] });
	assert.equal(by.has(pushing.id), false, "handled, and still waiting");
	assert.equal(by.has(before.id), false);
	await host.stop(pushing.id);
});

test("start_session and send_message take a model and effort for the turn, and refuse ones the session can't run", async (t) => {
	const { host, connect } = await mcp(t, true);
	const client = await connect();
	const settings = async (id: number) => {
		const state = await (await host.conversation(id)).viewState(context);
		try {
			const agent = state.value.docs["pi.agent"] as { model?: { modelId: string }; thinkingLevel?: string };
			return { model: agent.model?.modelId, thinking: agent.thinkingLevel };
		} finally {
			state.dispose();
		}
	};
	// faux-1 is the one pinned; faux-think, which reasons, is reached as faux/faux-think.
	// Left out: the host's defaults, as before.
	const plain = JSON.parse(text(await client.callTool({ name: "start_session", arguments: { project: "site", task: "Plain" } })));
	await idle(host, plain.id);
	assert.deepEqual(await settings(plain.id), { model: "faux-1", thinking: host.thinking });

	const chosen = JSON.parse(text(await client.callTool({ name: "start_session", arguments: { project: "site", task: "Think hard", model: "faux/faux-think", effort: "low" } })));
	await idle(host, chosen.id);
	assert.deepEqual(await settings(chosen.id), { model: "faux-think", thinking: "low" });

	for (const [args, pattern] of [
		[{ model: "gpt-0" }, /unknown model gpt-0: use one of faux-1, or provider\/id/],
		[{ effort: "max" }, /effort max isn't one faux\/faux-1 takes: use one of off/],
		[{ model: "faux/faux-think", effort: "turbo" }, /effort turbo isn't one faux\/faux-think takes: use one of off, minimal, low, medium, high/],
		[{ effort: "high" }, /effort high isn't one faux\/faux-1 takes: use one of off$/],
	] as const) {
		const before = (await host.sessions.list()).length;
		const refused = await client.callTool({ name: "start_session", arguments: { project: "site", task: "x", ...args } });
		assert.equal(refused.isError, true, JSON.stringify(args));
		assert.match(text(refused), pattern);
		assert.equal((await host.sessions.list()).length, before, "nothing started");
	}

	// send_message: checked against the session's model, and set before the message goes in.
	const refused = await client.callTool({ name: "send_message", arguments: { id: chosen.id, text: "x", effort: "xhigh" } });
	assert.equal(refused.isError, true);
	assert.match(text(refused), /faux\/faux-think takes/);
	assert.match(text(await client.callTool({ name: "send_message", arguments: { id: chosen.id, text: "Harder", effort: "high" } })), /submission/);
	await idle(host, chosen.id);
	assert.deepEqual(await settings(chosen.id), { model: "faux-think", thinking: "high" });
	assert.match(text(await client.callTool({ name: "send_message", arguments: { id: chosen.id, text: "Back", model: "faux-1", effort: "off" } })), /submission/);
	await idle(host, chosen.id);
	assert.deepEqual(await settings(chosen.id), { model: "faux-1", thinking: "off" });
	const unknown = await client.callTool({ name: "send_message", arguments: { id: chosen.id, text: "x", model: "nope" } });
	assert.match(text(unknown), /unknown model nope/);
	assert.deepEqual(await settings(chosen.id), { model: "faux-1", thinking: "off" }, "a refused call changes nothing");

	// The read tools say what each session's next turn runs on, in the form the write tools take.
	await client.callTool({ name: "send_message", arguments: { id: chosen.id, text: "Think", model: "faux/faux-think", effort: "medium" } });
	await idle(host, chosen.id);
	const listed = JSON.parse(text(await client.callTool({ name: "list_sessions", arguments: {} })));
	const of = (id: number) => listed.find((s: { id: number }) => s.id === id);
	assert.deepEqual([of(chosen.id).model, of(chosen.id).effort], ["faux/faux-think", "medium"]);
	assert.deepEqual([of(plain.id).model, of(plain.id).effort], ["faux-1", host.thinking], "a pinned model by its ID");
	assert.match(text(await client.callTool({ name: "read_session", arguments: { id: chosen.id } })), /\nModel: faux\/faux-think\nEffort: medium\n/);
	const gate = await check(client);
	const entry = gate.data.find((d) => d.id === chosen.id) as unknown as { model: string; effort: string };
	assert.deepEqual([entry.model, entry.effort], ["faux/faux-think", "medium"]);
});

type Archived = { id: number; title: string; archived: boolean; message: string };
const call = async (client: Client, name: string, id: number) => client.callTool({ name, arguments: { id } });

test("archive_session and unarchive_session hide a sandbox session from list_sessions and bring it back, idempotently", async (t) => {
	const { host, project, connect } = await mcp(t, true, { sandboxes: true });
	const client = await connect();
	const boxed = await host.sessions.createSandbox(project, "Boxed");
	await (await host.submit(boxed.id, "Boxed")).wait(context);
	await idle(host, boxed.id);
	const listed = async (includeArchived?: boolean) => JSON.parse(text(await client.callTool({ name: "list_sessions", arguments: includeArchived === undefined ? {} : { includeArchived } }))) as { id: number; archived?: boolean }[];

	const archived = JSON.parse(text(await call(client, "archive_session", boxed.id))) as Archived;
	assert.deepEqual(archived, { id: boxed.id, title: "Boxed", archived: true, message: `archived session ${boxed.id}` });
	assert.equal((await host.sessions.get(boxed.id))?.archived, true, "the apps' archive flag, not one of its own");
	assert.deepEqual((await listed()).map((s) => s.id), [], "hidden by default");
	assert.deepEqual((await listed(true)).map((s) => [s.id, s.archived]), [[boxed.id, true]], "still there with includeArchived");
	assert.match(text(await call(client, "read_session", boxed.id)), /^Session \d+: Boxed\n[\s\S]*## Agent\nThe build passes now\./, "still readable, transcript and all");
	const record = await host.sessions.get(boxed.id);
	assert.equal(record?.sandboxRemoved, undefined, "the archive itself deletes nothing");

	const again = JSON.parse(text(await call(client, "archive_session", boxed.id))) as Archived;
	assert.deepEqual(again, { id: boxed.id, title: "Boxed", archived: true, message: `session ${boxed.id} was already archived` });

	const back = JSON.parse(text(await call(client, "unarchive_session", boxed.id))) as Archived;
	assert.deepEqual(back, { id: boxed.id, title: "Boxed", archived: false, message: `unarchived session ${boxed.id}` });
	assert.deepEqual((await listed()).map((s) => s.id), [boxed.id]);
	assert.equal((await host.sessions.get(boxed.id))?.kept, true, "kept from the idle archive, as unarchiving in the apps does");
	const backAgain = JSON.parse(text(await call(client, "unarchive_session", boxed.id))) as Archived;
	assert.deepEqual(backAgain, { id: boxed.id, title: "Boxed", archived: false, message: `session ${boxed.id} wasn't archived` });
});

test("archive_session refuses a running or waiting session, and both tools refuse local sessions and unknown ids", async (t) => {
	const { host, project, connect } = await mcp(t, true, { sandboxes: true, approvals: "ask", responses: SCRIPTED });
	const client = await connect();

	const sleeping = await host.sessions.createSandbox(project, "Sleep");
	void host.submit(sleeping.id, "sleep");
	await until(async () => (await host.sessions.states()).get(sleeping.id) === "running", "the run");
	const running = await call(client, "archive_session", sleeping.id);
	assert.equal(running.isError, true);
	assert.match(text(running), new RegExp(`session ${sleeping.id} is running, and only a session at rest \\(done, failed, stopped or idle\\) can be archived`));
	assert.equal((await host.sessions.get(sleeping.id))?.archived, undefined);
	await host.stop(sleeping.id);
	await idle(host, sleeping.id);
	assert.equal(JSON.parse(text(await call(client, "archive_session", sleeping.id))).archived, true, "stopped, it can go");

	const pushing = await host.sessions.createSandbox(project, "Push it");
	void host.submit(pushing.id, "push it");
	await until(async () => (await host.approvals.pending()).some((r) => r.conversationId === pushing.id), "the approval");
	const waiting = await call(client, "archive_session", pushing.id);
	assert.equal(waiting.isError, true);
	assert.match(text(waiting), new RegExp(`session ${pushing.id} is waiting for approval`));
	assert.equal((await host.sessions.get(pushing.id))?.archived, undefined);
	await host.stop(pushing.id);

	// The user's own local session, archived from the apps or not: neither tool touches it, sandboxOnly off as it is here.
	const mine = await host.sessions.create(project, "Mine");
	await (await host.submit(mine.id, "Mine")).wait(context);
	await idle(host, mine.id);
	for (const name of ["archive_session", "unarchive_session"]) {
		const refused = await call(client, name, mine.id);
		assert.equal(refused.isError, true, name);
		assert.match(text(refused), new RegExp(`session ${mine.id} isn't in a sandbox, and ${name} acts only on sandbox sessions`), name);
	}
	await host.sessions.archive(mine.id, true);
	assert.match(text(await call(client, "unarchive_session", mine.id)), /isn't in a sandbox/);
	assert.equal((await host.sessions.get(mine.id))?.archived, true, "still archived");

	for (const name of ["archive_session", "unarchive_session"]) {
		const missing = await call(client, name, 999);
		assert.equal(missing.isError, true, name);
		assert.match(text(missing), /^No session 999; list_sessions lists them/, name);
	}
});

test("sandboxOnly: archive_session and unarchive_session refuse local sessions with sandboxOnly's error, and are read-only tokens' to lack", async (t) => {
	const { host, project, connect, reader, bearer } = await mcp(t, true, { sandboxOnly: true, sandboxes: true });
	const client = await connect();
	const mine = await host.sessions.create(project, "Mine");
	await (await host.submit(mine.id, "Mine")).wait(context);
	for (const name of ["archive_session", "unarchive_session"]) {
		const refused = await call(client, name, mine.id);
		assert.equal(refused.isError, true, name);
		assert.match(text(refused), new RegExp(`session ${mine.id} isn't in a sandbox, and this endpoint acts only on sandbox sessions \\(mcp.sandboxOnly\\)`), name);
	}
	assert.equal((await host.sessions.get(mine.id))?.archived, undefined);
	const tools = (await client.listTools()).tools;
	for (const name of ["archive_session", "unarchive_session"]) assert.match(tools.find((tool) => tool.name === name)?.description ?? "", /Sandbox-only/, name);

	const readOnly = await connect(bearer(reader.secret));
	const refused = await readOnly.callTool({ name: "archive_session", arguments: { id: mine.id } });
	assert.equal(refused.isError, true);
	assert.match(text(refused), /archive_session not found/);
});

test("sandboxOnly without a sandbox host: archive_session and unarchive_session fail closed", async (t) => {
	const { host, project, connect } = await mcp(t, true, { sandboxOnly: true });
	const client = await connect();
	const mine = await host.sessions.create(project, "Mine");
	await (await host.submit(mine.id, "Mine")).wait(context);
	for (const name of ["archive_session", "unarchive_session"]) {
		const refused = await call(client, name, mine.id);
		assert.equal(refused.isError, true, name);
		assert.match(text(refused), /mcp.sandboxOnly is on but the settings name no sandbox host/, name);
	}
});

test("archive_session refuses a sandbox session whose branch was discarded, since its sandbox would go unfetched", async (t) => {
	const { host, project, connect } = await mcp(t, true, { sandboxes: true });
	const client = await connect();
	const boxed = await host.sessions.createSandbox(project, "Boxed");
	await (await host.submit(boxed.id, "Boxed")).wait(context);
	await idle(host, boxed.id);
	await host.sandboxes.discard(boxed.id);
	const refused = await call(client, "archive_session", boxed.id);
	assert.equal(refused.isError, true);
	assert.match(text(refused), /branch was discarded/);
	assert.equal((await host.sessions.get(boxed.id))?.archived, undefined);
});
