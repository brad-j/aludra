import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { createApi } from "../src/api.ts";
import { configFor } from "../src/config.ts";
import { context } from "../src/host.ts";
import { transcriptText } from "../src/mcp.ts";
import { fakeSandboxes, gitProject, makeProject, SANDBOX_SETTINGS, tempDir, testHost } from "./helpers.ts";

const USER = "you@example.com";

/** A faux host with its API on a free port and a read token and a write token for /mcp. `write` turns on mcp.write;
 * `connect` uses the write token unless given other headers. */
async function mcp(t: TestContext, write: boolean, options: { sandboxOnly?: boolean; sandboxes?: boolean } = {}) {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	faux.setResponses(Array.from({ length: 20 }, () => fauxAssistantMessage(fauxText("The build passes now."))));
	const models = createModels();
	models.setProvider(faux.provider);
	const fake = options.sandboxes === true ? fakeSandboxes(tempDir(t)) : undefined;
	if (fake !== undefined) t.after(() => fake.close());
	const { host, dir, config } = await testHost(t, { models, model: { provider: "faux", modelId: "faux-1" }, ...(fake === undefined ? {} : { sandboxes: fake.sandboxes, settings: SANDBOX_SETTINGS }) });
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

const text = (result: unknown) => ((result as { content: { text: string }[] }).content[0]!.text);

test("read-only: an agent lists projects and sessions, reads a transcript and searches, and has no tools to write", async (t) => {
	const { host, project, connect, writer } = await mcp(t, false);
	const session = await host.sessions.create(project, "Fix the build");
	await (await host.submit(session.id, "Fix the build")).wait(context);

	// A write token, but mcp.write is off.
	const client = await connect();
	assert.match(client.getInstructions() ?? "", /egwene.*read-only for you: the host's mcp.write setting is off/s);
	const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
	assert.deepEqual(tools, ["list_projects", "list_sessions", "read_session", "search_messages"]);
	assert.ok((await client.listTools()).tools.every((tool) => tool.annotations?.readOnlyHint === true));

	assert.deepEqual(JSON.parse(text(await client.callTool({ name: "list_projects", arguments: {} }))).map((p: { name: string }) => p.name), ["site"]);
	const sessions = JSON.parse(text(await client.callTool({ name: "list_sessions", arguments: {} })));
	assert.deepEqual(sessions.map((s: { id: number; state: string }) => [s.id, s.state]), [[session.id, "done"]]);
	const transcript = text(await client.callTool({ name: "read_session", arguments: { id: session.id } }));
	assert.match(transcript, /^Session \d+: Fix the build\nProject: site/);
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
	assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), ["list_projects", "list_sessions", "read_session", "search_messages"]);
	const refused = await client.callTool({ name: "start_session", arguments: { project: "site", task: "x" } });
	assert.equal(refused.isError, true);
	assert.equal((await host.sessions.list()).length, 0, "no session was started");
});

test("with a write token and mcp.write, an agent starts a session, messages it and stops it", async (t) => {
	const { host, connect } = await mcp(t, true);
	const client = await connect();
	assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), ["list_projects", "list_sessions", "read_session", "search_messages", "send_message", "start_session", "stop_session"]);
	const started = JSON.parse(text(await client.callTool({ name: "start_session", arguments: { project: "site", task: "Make the build pass\nIt fails on main." } })));
	assert.equal((await host.sessions.get(started.id))?.title, "Make the build pass");
	while ((await host.sessions.states()).get(started.id) !== "idle") await new Promise((resolve) => setTimeout(resolve, 10));
	assert.match(text(await client.callTool({ name: "send_message", arguments: { id: started.id, text: "And add a test" } })), /submission/);
	assert.match(text(await client.callTool({ name: "stop_session", arguments: { id: started.id } })), /stopped/);
	const wrong = await client.callTool({ name: "start_session", arguments: { project: "nope", task: "x" } });
	assert.equal(wrong.isError, true);
});

const WRITE_TOOLS = ["list_projects", "list_sessions", "read_session", "search_messages", "send_message", "start_session", "stop_session"];

/** Waits until session `id` has finished its run. */
async function idle(host: Awaited<ReturnType<typeof mcp>>["host"], id: number) {
	while ((await host.sessions.states()).get(id) !== "idle") await new Promise((resolve) => setTimeout(resolve, 10));
}

test("sandboxOnly: start_session always makes a sandbox session and refuses to make a local one", async (t) => {
	const { host, connect } = await mcp(t, true, { sandboxOnly: true, sandboxes: true });
	const client = await connect();
	const tools = (await client.listTools()).tools;
	assert.deepEqual(tools.map((tool) => tool.name).sort(), WRITE_TOOLS, "no tool syncs, merges, ships or archives");
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
