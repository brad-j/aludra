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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeSandboxes, git, gitProject, makeProject, SANDBOX_SETTINGS, tempDir, testHost } from "./helpers.ts";

const USER = "you@example.com";

/** A faux host with its API on a free port and a read token and a write token for /mcp. `write` turns on mcp.write;
 * `connect` uses the write token unless given other headers. */
async function mcp(t: TestContext, write: boolean, options: { sandboxOnly?: boolean; worktreeOnly?: boolean; git?: boolean; remote?: boolean; sandboxes?: boolean; approvals?: "ask" | "off"; responses?: FauxResponseStep[] } = {}) {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }, { id: "faux-think", reasoning: true }] });
	faux.setResponses(options.responses ?? Array.from({ length: 20 }, () => fauxAssistantMessage(fauxText("The build passes now."))));
	const models = createModels();
	models.setProvider(faux.provider);
	const fake = options.sandboxes === true ? fakeSandboxes(tempDir(t)) : undefined;
	if (fake !== undefined) t.after(() => fake.close());
	const dir = tempDir(t);
	const settings = fake === undefined ? {} : { sandboxes: { ...SANDBOX_SETTINGS.sandboxes, ...(options.approvals === undefined ? {} : { approvals: options.approvals }) } };
	const { host, config } = await testHost(t, { dir, models, model: { provider: "faux", modelId: "faux-1" }, settings, ...(fake === undefined ? {} : { sandboxes: fake.sandboxes }) });
	config.mcp.write = write;
	config.mcp.sandboxOnly = options.sandboxOnly === true;
	config.mcp.worktreeOnly = options.worktreeOnly === true;
	const made = fake === undefined && options.git !== true ? { project: makeProject(dir, "site"), remote: undefined } : gitProject(dir, "site", undefined, { remote: options.remote === true });
	const { project } = made;
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
	return { host, project, remote: made.remote, url, connect, reader, writer, bearer, fake, dir, config };
}

const READ_TOOLS = ["list_projects", "list_sessions", "read_plan", "read_session", "read_subscription", "search_messages"];
const WRITE_TOOLS = [...READ_TOOLS, "archive_session", "send_message", "start_session", "stop_session", "unarchive_session"].sort();

const text = (result: unknown) => ((result as { content: { text: string }[] }).content[0]!.text);
const json = (result: unknown) => JSON.parse(text(result));

test("read-only: an agent lists projects and sessions, reads a transcript and searches, and has no tools to write", async (t) => {
	const { host, project, connect, writer } = await mcp(t, false);
	const session = await host.sessions.create(project, "Fix the build");
	await (await host.submit(session.id, "Fix the build")).wait(context);

	// A write token, but mcp.write is off.
	const client = await connect();
	assert.match(client.getInstructions() ?? "", /egwene.*read-only for you: the host's mcp.write setting is off/s);
	const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
	assert.deepEqual(tools, READ_TOOLS);
	assert.ok((await client.listTools()).tools.every((tool) => tool.annotations?.readOnlyHint === true));

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

test("read_subscription says nothing is known until a Claude answer reports the windows, then gives each with its reset", async (t) => {
	const resets = Math.round(Date.now() / 1000) + 3600;
	const limited = { ...fauxAssistantMessage(fauxText("Done.")), diagnostics: [{ type: "claude-code.rate-limit", timestamp: Date.now(), details: { status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.9, resetsAt: resets, overageStatus: "allowed", isUsingOverage: false } }] };
	const { host, project, connect, reader, bearer } = await mcp(t, false, { responses: [limited] });
	const client = await connect(bearer(reader.secret));
	assert.deepEqual(JSON.parse(text(await client.callTool({ name: "read_subscription", arguments: {} }))), { known: false });
	const session = await host.sessions.create(project, "x");
	await (await host.submit(session.id, "x")).wait(context);
	const known = JSON.parse(text(await client.callTool({ name: "read_subscription", arguments: {} })));
	assert.equal(known.known, true);
	assert.equal(known.status, "allowed_warning");
	assert.deepEqual(known.windows, { seven_day: { used: 0.9, resetsAt: new Date(resets * 1000).toISOString(), status: "allowed_warning" } });
	assert.deepEqual(known.overage, { status: "allowed", inUse: false });
});

test("read_plan gives a read token a project's plan, says when there's none, and fails for an unknown project", async (t) => {
	const { project, connect, reader, bearer } = await mcp(t, false);
	const client = await connect(bearer(reader.secret));
	const none = await client.callTool({ name: "read_plan", arguments: { project: "site" } });
	assert.equal(none.isError, undefined);
	assert.deepEqual(JSON.parse(text(none)), { project: "site", path: "docs/plan.md", exists: false });
	mkdirSync(join(project.dir, "docs"), { recursive: true });
	writeFileSync(join(project.dir, "docs/plan.md"), "# Plan\n\n## Now\n");
	const plan = JSON.parse(text(await client.callTool({ name: "read_plan", arguments: { project: "site" } })));
	assert.equal(plan.exists, true);
	assert.equal(plan.text, "# Plan\n\n## Now\n");
	const unknown = await client.callTool({ name: "read_plan", arguments: { project: "nope" } });
	assert.equal(unknown.isError, true);
	assert.match(text(unknown), /no project nope/);
});

const PLAN = "# Plan\n\n## Now\n\n### first: The first step\nKind: step\nDo it.\n\n## Next\n\n## Questions\n\n## Later\n\n## Done\n";

test("start_session takes the plan item it's for and where it came from, and the session carries both", async (t) => {
	const { host, project, connect } = await mcp(t, true, { sandboxes: true, sandboxOnly: true });
	mkdirSync(join(project.dir, "docs"), { recursive: true });
	writeFileSync(join(project.dir, "docs", "plan.md"), PLAN);
	const client = await connect();
	const origin = "https://verin.example.ts.net/threads/01JX";
	const started = json(await client.callTool({ name: "start_session", arguments: { project: "site", task: "Do the first step", sandbox: true, planItem: "first", origin } }));
	assert.equal(started.planItem, "first");
	assert.equal(started.origin, origin);
	const record = await host.sessions.get(started.id);
	assert.equal(record?.planItem, "first");
	assert.equal(record?.origin, origin);
	const listed = json(await client.callTool({ name: "list_sessions", arguments: {} })).find((s: { id: number }) => s.id === started.id);
	assert.equal(listed.planItem, "first");
	assert.equal(listed.origin, origin);
	assert.match(text(await client.callTool({ name: "read_session", arguments: { id: started.id } })), new RegExp(`Plan item: first\nOrigin: ${origin.replace(/[.]/g, "\\.")}`));

	// An item the plan doesn't have, a bad id and a link that isn't https are refused, with nothing started.
	const before = (await host.sessions.list()).length;
	assert.match(text(await client.callTool({ name: "start_session", arguments: { project: "site", task: "x", sandbox: true, planItem: "missing" } })), /has no item missing; read_plan shows its items/);
	assert.equal((await client.callTool({ name: "start_session", arguments: { project: "site", task: "x", sandbox: true, planItem: "Not An Id" } })).isError, true);
	assert.match(text(await client.callTool({ name: "start_session", arguments: { project: "site", task: "x", sandbox: true, origin: "http://plain.example" } })), /origin should be an https link/);
	assert.equal((await host.sessions.list()).length, before);
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

test("mcp.write, mcp.sandboxOnly and mcp.worktreeOnly come from the settings file, are off by default, and sandboxOnly and worktreeOnly can't both be on", () => {
	const workspaces = [{ name: "a", roots: [] }];
	assert.deepEqual(configFor(JSON.stringify({ workspaces }), {}).config.mcp, { write: false, sandboxOnly: false, worktreeOnly: false });
	assert.deepEqual(configFor(JSON.stringify({ workspaces, mcp: { write: true } }), {}).config.mcp, { write: true, sandboxOnly: false, worktreeOnly: false });
	assert.deepEqual(configFor(JSON.stringify({ workspaces, mcp: { write: true, sandboxOnly: true } }), {}).config.mcp, { write: true, sandboxOnly: true, worktreeOnly: false });
	assert.deepEqual(configFor(JSON.stringify({ workspaces, mcp: { write: true, worktreeOnly: true } }), {}).config.mcp, { write: true, sandboxOnly: false, worktreeOnly: true });
	assert.match(configFor(JSON.stringify({ workspaces, mcp: { sandboxOnly: "yes" } }), {}).errors.join("\n"), /sandboxOnly/);
	assert.match(configFor(JSON.stringify({ workspaces, mcp: { sandboxOnly: true, worktreeOnly: true } }), {}).errors.join("\n"), /both on/);
});

test("a settings file with the retired mcp keys (ship, shipWorktrees, allowNewProjects, writePlans) still loads, and they're ignored", () => {
	const workspaces = [{ name: "a", roots: [] }];
	const loaded = configFor(JSON.stringify({ workspaces, mcp: { write: true, sandboxOnly: true, ship: true, shipWorktrees: true, allowNewProjects: true, writePlans: true } }), {});
	assert.deepEqual(loaded.errors, []);
	assert.deepEqual(loaded.config.mcp, { write: true, sandboxOnly: true, worktreeOnly: false });
});

test("start_session needs a project, in every mode, and makes nothing without one", async (t) => {
	for (const mode of [{}, { sandboxOnly: true }, { worktreeOnly: true }]) {
		const { host, connect } = await mcp(t, true, { sandboxes: true, ...mode });
		const client = await connect();
		const tool = (await client.listTools()).tools.find((x) => x.name === "start_session")!;
		assert.ok((tool.inputSchema.required ?? []).includes("project"), "project is required");
		assert.doesNotMatch(tool.description ?? "", /scratch/);
		const refused = await client.callTool({ name: "start_session", arguments: { task: "Sketch an idea" } });
		assert.equal(refused.isError, true);
		assert.deepEqual(await host.sessions.list(), [], "nothing was made");
	}
});

test("a long transcript keeps its latest items", () => {
	const items = Array.from({ length: 100 }, (_, i) => ({ kind: "user" as const, id: String(i), text: `message ${i} ${"x".repeat(100)}`, at: i }));
	const shown = transcriptText(items, 2000);
	assert.match(shown, /^\(\d+ earlier items left out\)/);
	assert.match(shown, /message 99/);
	assert.doesNotMatch(shown, /message 0 /);
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
		assert.match(text(refused), new RegExp(`session ${mine.id} isn't in a sandbox or a worktree, and ${name} acts only on those`), name);
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
	for (const name of ["archive_session", "unarchive_session"]) assert.match(tools.find((tool) => tool.name === name)?.description ?? "", /Sandbox and worktree sessions only/, name);

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


/** Answers each message by running `command` with bash, then reporting what came back. */
function running(command: string): FauxResponseStep[] {
	return Array.from({ length: 20 }, () => (ctx: TranscriptContext) => {
		const last = ctx.messages.at(-1);
		if (last?.role === "toolResult") return fauxAssistantMessage(fauxText(`result: ${JSON.stringify(last.content)}`));
		return fauxAssistantMessage(fauxToolCall("bash", { command }), { stopReason: "toolUse" });
	});
}

test("worktreeOnly: start_session works in a worktree of the last commit on worktree/N, and the checkout is never touched", async (t) => {
	const { host, project, connect } = await mcp(t, true, { worktreeOnly: true, git: true, responses: running("echo two > a.txt && git commit -qam 'from the session' && git log --oneline -1") });
	// Uncommitted work in the checkout, which the session must neither see nor change.
	writeFileSync(join(project.dir, "a.txt"), "mine, uncommitted\n");
	const before = git(project.dir, "rev-parse", "HEAD");
	const client = await connect();
	assert.match(client.getInstructions() ?? "", /in worktrees only/);
	const started = JSON.parse(text(await client.callTool({ name: "start_session", arguments: { project: "site", task: "Change a.txt" } })));
	assert.equal(started.branch, "worktree/0");
	assert.notEqual(started.dir, project.dir);
	await idle(host, started.id);
	const record = await host.sessions.get(started.id);
	assert.equal(record?.worktree, 0);
	assert.equal(record?.source, project.dir);
	assert.equal(readFileSync(join(started.dir, "a.txt"), "utf8"), "two\n");
	assert.equal(git(project.dir, "log", "-1", "--format=%s", "worktree/0"), "from the session");
	// The checkout: same branch, same commit, same uncommitted file.
	assert.equal(git(project.dir, "rev-parse", "--abbrev-ref", "HEAD"), "main");
	assert.equal(git(project.dir, "rev-parse", "HEAD"), before);
	assert.equal(readFileSync(join(project.dir, "a.txt"), "utf8"), "mine, uncommitted\n");
	// A second session gets the next branch.
	const second = JSON.parse(text(await client.callTool({ name: "start_session", arguments: { project: "site", task: "Again" } })));
	assert.equal(second.branch, "worktree/1");
	await idle(host, second.id);

	for (const args of [{ worktree: false }, { sandbox: true }]) {
		const refused = await client.callTool({ name: "start_session", arguments: { project: "site", task: "Elsewhere", ...args } });
		assert.equal(refused.isError, true, JSON.stringify(args));
		assert.match(text(refused), /only worktree sessions \(mcp.worktreeOnly\)/);
	}
	// A session started from the apps, in the checkout, can't be messaged or stopped here.
	const local = await host.sessions.create(project, "Mine");
	for (const name of ["send_message", "stop_session"]) {
		const refused = await client.callTool({ name, arguments: { id: local.id, ...(name === "send_message" ? { text: "x" } : {}) } });
		assert.equal(refused.isError, true, name);
		assert.match(text(refused), /isn't in a worktree/, name);
	}
});

test("a worktree session's git push is refused without asking", async (t) => {
	const { host, connect } = await mcp(t, true, { worktreeOnly: true, git: true, responses: running("git push origin HEAD") });
	const client = await connect();
	const started = JSON.parse(text(await client.callTool({ name: "start_session", arguments: { project: "site", task: "Push it" } })));
	await idle(host, started.id);
	const answer = JSON.stringify((await (await host.conversation(started.id)).context(context)).messages.at(-1));
	assert.match(answer, /git push is refused in it/);
	assert.deepEqual((await host.approvals.pending()).filter((r) => r.conversationId === started.id), [], "nothing was asked");
});

test("a worktree session's push spelled so the hook can't read it still fails, and the remote doesn't move", async (t) => {
	const { host, remote, connect } = await mcp(t, true, { worktreeOnly: true, git: true, remote: true, responses: running("git commit -q --allow-empty -m more && g=git; $g push origin HEAD:main; echo exit=$?") });
	const at = git(remote!, "rev-parse", "main");
	const client = await connect();
	const started = JSON.parse(text(await client.callTool({ name: "start_session", arguments: { project: "site", task: "Push it" } })));
	await idle(host, started.id);
	const answer = JSON.stringify((await (await host.conversation(started.id)).context(context)).messages.at(-1));
	assert.match(answer, /exit=[1-9]/, "the push failed");
	assert.equal(git(remote!, "rev-parse", "main"), at, "the remote didn't move");
	assert.deepEqual((await host.approvals.pending()).filter((r) => r.conversationId === started.id), [], "nothing was asked");
});

test("a worktree session's shell rewrites push URLs to one that can't be reached, and fetch still works", async (t) => {
	const dir = tempDir(t);
	const { project, remote } = gitProject(dir, "site", { "a.txt": "one\n" }, { remote: true });
	// A push spelled so the approvals hook doesn't read it as one, run with the session's environment.
	const { WORKTREE_ENV } = await import("../src/host.ts");
	const { execFileSync } = await import("node:child_process");
	const env = { ...process.env, ...WORKTREE_ENV };
	execFileSync("git", ["-C", project.dir, "commit", "-q", "--allow-empty", "-m", "more"]);
	const pushed = (() => {
		try {
			execFileSync("sh", ["-c", "g=git; $g -C \"$0\" push -q origin main", project.dir], { env, stdio: "pipe" });
			return true;
		} catch {
			return false;
		}
	})();
	assert.equal(pushed, false, "the push failed");
	assert.notEqual(git(remote!, "rev-parse", "main"), git(project.dir, "rev-parse", "main"), "the remote didn't move");
	execFileSync("git", ["-C", project.dir, "fetch", "-q", "origin"], { env });
	assert.ok(existsSync(remote!));
});

test("without worktreeOnly, worktree: true asks for a worktree session, and a sandbox and a worktree together are refused", async (t) => {
	const { host, project, connect } = await mcp(t, true, { git: true });
	const client = await connect();
	const started = JSON.parse(text(await client.callTool({ name: "start_session", arguments: { project: "site", task: "Here", worktree: true } })));
	assert.equal(started.branch, "worktree/0");
	await idle(host, started.id);
	const both = await client.callTool({ name: "start_session", arguments: { project: "site", task: "Both", worktree: true, sandbox: true } });
	assert.equal(both.isError, true);
	assert.match(text(both), /not both/);
	assert.equal(git(project.dir, "rev-parse", "--abbrev-ref", "HEAD"), "main");
});

test("a project that isn't in git can't have a worktree session", async (t) => {
	const { host, connect } = await mcp(t, true, { worktreeOnly: true });
	const client = await connect();
	const refused = await client.callTool({ name: "start_session", arguments: { project: "site", task: "x" } });
	assert.equal(refused.isError, true);
	assert.match(text(refused), /isn't in git/);
	assert.equal((await host.sessions.list()).length, 0);
});
