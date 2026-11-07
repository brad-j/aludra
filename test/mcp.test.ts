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
import { makeProject, testHost } from "./helpers.ts";

const USER = "you@example.com";

/** A faux host with its API on a free port and a read token and a write token for /mcp. `write` turns on mcp.write;
 * `connect` uses the write token unless given other headers. */
async function mcp(t: TestContext, write: boolean) {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	faux.setResponses(Array.from({ length: 20 }, () => fauxAssistantMessage(fauxText("The build passes now."))));
	const models = createModels();
	models.setProvider(faux.provider);
	const { host, dir, config } = await testHost(t, { models, model: { provider: "faux", modelId: "faux-1" } });
	config.mcp.write = write;
	const project = makeProject(dir, "site");
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

test("mcp.write comes from the settings file and is off by default", () => {
	assert.equal(configFor(JSON.stringify({ workspaces: [{ name: "a", roots: [] }] }), {}).config.mcp.write, false);
	assert.equal(configFor(JSON.stringify({ workspaces: [{ name: "a", roots: [] }], mcp: { write: true } }), {}).config.mcp.write, true);
});

test("a long transcript keeps its latest items", () => {
	const items = Array.from({ length: 100 }, (_, i) => ({ kind: "user" as const, id: String(i), text: `message ${i} ${"x".repeat(100)}`, at: i }));
	const shown = transcriptText(items, 2000);
	assert.match(shown, /^\(\d+ earlier items left out\)/);
	assert.match(shown, /message 99/);
	assert.doesNotMatch(shown, /message 0 /);
});
