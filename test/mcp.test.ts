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

/** A faux host with its API on a free port, and an MCP client signed in as `login`. `write` turns on mcp.write. */
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
	const connect = async (headers: Record<string, string> = { "tailscale-user-login": USER }) => {
		const client = new Client({ name: "test", version: "1" });
		await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers } }));
		t.after(() => client.close());
		return client;
	};
	return { host, project, url, connect };
}

const text = (result: unknown) => ((result as { content: { text: string }[] }).content[0]!.text);

test("read-only: an agent lists projects and sessions, reads a transcript and searches, and has no tools to write", async (t) => {
	const { host, project, connect } = await mcp(t, false);
	const session = await host.sessions.create(project, "Fix the build");
	await (await host.submit(session.id, "Fix the build")).wait(context);

	const client = await connect();
	assert.match(client.getInstructions() ?? "", /egwene.*read-only/s);
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
});

test("with mcp.write, an agent starts a session, messages it and stops it", async (t) => {
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

test("only listed Tailscale logins, no browsers, and only POST", async (t) => {
	const { url, connect } = await mcp(t, false);
	await assert.rejects(connect({}), /403|Forbidden/);
	await assert.rejects(connect({ "tailscale-user-login": "someone@else.com" }), /403|Forbidden/);
	const fromPage = await fetch(`${url}/mcp`, { method: "POST", headers: { "tailscale-user-login": USER, origin: "https://evil.example", "content-type": "application/json" }, body: "{}" });
	assert.equal(fromPage.status, 403);
	assert.equal((await fetch(`${url}/mcp`, { headers: { "tailscale-user-login": USER } })).status, 405);
	const bad = await fetch(`${url}/mcp`, { method: "POST", headers: { "tailscale-user-login": USER, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{not json" });
	assert.equal(bad.status, 400);
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
