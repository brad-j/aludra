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
import { readSummary } from "../src/live.ts";
import { transcriptText } from "../src/mcp.ts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeGh, fakeSandboxes, git, gitProject, makeProject, SANDBOX_SETTINGS, tempDir, testHost } from "./helpers.ts";

const USER = "you@example.com";

/** A faux host with its API on a free port and a read token and a write token for /mcp. `write` turns on mcp.write;
 * `connect` uses the write token unless given other headers. */
async function mcp(t: TestContext, write: boolean, options: { sandboxOnly?: boolean; worktreeOnly?: boolean; ship?: boolean; shipWorktrees?: boolean; git?: boolean; remote?: boolean; sandboxes?: boolean; approvals?: "ask" | "off"; responses?: FauxResponseStep[]; allowNewProjects?: boolean; newProjects?: boolean; writePlans?: boolean } = {}) {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }, { id: "faux-think", reasoning: true }] });
	faux.setResponses(options.responses ?? Array.from({ length: 20 }, () => fauxAssistantMessage(fauxText("The build passes now."))));
	const models = createModels();
	models.setProvider(faux.provider);
	const fake = options.sandboxes === true ? fakeSandboxes(tempDir(t)) : undefined;
	if (fake !== undefined) t.after(() => fake.close());
	// New projects go beside "site", with a gh that makes local bare repositories.
	const dir = tempDir(t);
	const gh = options.newProjects === true ? fakeGh(join(dir, "github")) : undefined;
	const settings = {
		...(fake === undefined ? {} : { sandboxes: { ...SANDBOX_SETTINGS.sandboxes, ...(options.approvals === undefined ? {} : { approvals: options.approvals }) } }),
		...(gh === undefined ? {} : { newProjects: { root: join(dir, "Projects", "Software"), owner: "t" } }),
	};
	const { host, config } = await testHost(t, { dir, models, model: { provider: "faux", modelId: "faux-1" }, settings, ...(fake === undefined ? {} : { sandboxes: fake.sandboxes }), ...(gh === undefined ? {} : { newProjects: gh }) });
	config.mcp.write = write;
	config.mcp.sandboxOnly = options.sandboxOnly === true;
	config.mcp.worktreeOnly = options.worktreeOnly === true;
	config.mcp.ship = options.ship === true;
	config.mcp.shipWorktrees = options.shipWorktrees === true;
	config.mcp.allowNewProjects = options.allowNewProjects === true;
	config.mcp.writePlans = options.writePlans === true;
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
	return { host, project, remote: made.remote, url, connect, reader, writer, bearer, fake, dir, gh, config };
}

const READ_TOOLS = ["check_sessions", "list_projects", "list_sessions", "mark_sessions_handled", "read_plan", "read_session", "read_subscription", "search_messages"];
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

test("write_plan is offered only to a write token while mcp.write and mcp.writePlans are both on", async (t) => {
	const has = async (write: boolean, writePlans: boolean, read = false) => {
		const { connect, reader, bearer } = await mcp(t, write, { writePlans });
		const client = await connect(read ? bearer(reader.secret) : undefined);
		return (await client.listTools()).tools.some((tool) => tool.name === "write_plan");
	};
	assert.equal(await has(true, false), false, "mcp.writePlans off");
	assert.equal(await has(false, true), false, "mcp.write off");
	assert.equal(await has(true, true, true), false, "a read token");
	assert.equal(await has(true, true), true);
});

test("write_plan makes a plan where there's none, edits it from read_plan's sha256, and refuses a stale base", async (t) => {
	const { project, connect } = await mcp(t, true, { writePlans: true, worktreeOnly: true });
	const client = await connect();
	const tool = (await client.listTools()).tools.find((t) => t.name === "write_plan")!;
	assert.match(tool.description ?? "", /real checkout on this machine, not a worktree/);
	const call = (args: Record<string, unknown>) => client.callTool({ name: "write_plan", arguments: { project: "site", ...args } });

	const made = await call({ text: PLAN, base: null });
	assert.equal(made.isError, undefined, text(made));
	const first = JSON.parse(text(made));
	assert.equal(first.path, "docs/plan.md");
	assert.deepEqual(first.items, { added: ["first"], removed: [], moved: [], changed: [] });
	assert.equal(readFileSync(join(project.dir, "docs/plan.md"), "utf8"), PLAN);

	const again = await call({ text: PLAN, base: null });
	assert.equal(again.isError, true);
	assert.match(text(again), /has a docs\/plan.md now.*Nothing was written/s);

	const read = JSON.parse(text(await client.callTool({ name: "read_plan", arguments: { project: "site" } })));
	assert.equal(read.sha256, first.sha256);
	const edited = PLAN.replace("## Next\n", "## Next\n\n### second: Then this\nKind: chore · Needs: first\n").replace("Do it.", "Do it well.");
	const wrote = JSON.parse(text(await call({ text: edited, base: read.sha256 })));
	assert.deepEqual(wrote.items, { added: ["second"], removed: [], moved: [], changed: ["first"] });

	// Someone edits the file between a read and a write: the stale base is refused and nothing is written.
	writeFileSync(join(project.dir, "docs/plan.md"), edited.replace("Then this", "Then that"));
	const stale = await call({ text: edited, base: wrote.sha256 });
	assert.equal(stale.isError, true);
	assert.match(text(stale), /changed since it was read.*read_plan it again/s);
	assert.match(readFileSync(join(project.dir, "docs/plan.md"), "utf8"), /Then that/);

	const invalid = await call({ text: "# Plan\n\n## Now\n", base: JSON.parse(text(await client.callTool({ name: "read_plan", arguments: { project: "site" } }))).sha256 });
	assert.equal(invalid.isError, true);
	assert.match(text(invalid), /sections[\s\S]*first, second are missing/);
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

test("start_session without a project makes a scratch sandbox session, with or without sandboxOnly, and never a local one", async (t) => {
	for (const sandboxOnly of [false, true]) {
		const { host, connect } = await mcp(t, true, { sandboxOnly, sandboxes: true });
		const client = await connect();
		const tool = (await client.listTools()).tools.find((x) => x.name === "start_session")!;
		assert.ok(!(tool.inputSchema.required ?? []).includes("project"), "project is optional");
		assert.match(tool.description ?? "", /scratch session/);

		const started = JSON.parse(text(await client.callTool({ name: "start_session", arguments: { task: "Sketch an idea" } })));
		assert.equal(started.scratch, true);
		assert.equal(typeof started.sandbox, "number");
		const record = (await host.sessions.get(started.id))!;
		assert.equal(record.scratch, true);
		assert.ok(record.sandboxNumber !== undefined, "it's a sandbox session");
		assert.equal(record.source, join(host.scratchRoot, String(started.id)), "its work comes home to a repository of its own");
		assert.equal(JSON.parse(text(await client.callTool({ name: "start_session", arguments: { task: "Again", sandbox: true } }))).scratch, true);

		// A local scratch session isn't offered, sandboxOnly or not.
		const before = (await host.sessions.list()).length;
		const local = await client.callTool({ name: "start_session", arguments: { task: "Here", sandbox: false } });
		assert.equal(local.isError, true);
		assert.match(text(local), sandboxOnly ? /mcp.sandboxOnly/ : /no project runs only in a sandbox/);
		assert.equal((await host.sessions.list()).length, before, "no session was started");
	}
});

test("start_session without a project needs a sandbox host, and makes nothing without one", async (t) => {
	const { host, connect } = await mcp(t, true);
	const client = await connect();
	const refused = await client.callTool({ name: "start_session", arguments: { task: "Sketch an idea" } });
	assert.equal(refused.isError, true);
	assert.match(text(refused), /no project runs in a sandbox, and the settings name no sandbox host/);
	assert.deepEqual(await host.sessions.list(), []);
});

test("worktreeOnly refuses start_session without a project, since a worktree needs one and a scratch session is a sandbox", async (t) => {
	// A sandbox host is set, so the refusal can't be the missing host's.
	const { host, connect } = await mcp(t, true, { worktreeOnly: true, sandboxes: true });
	const client = await connect();
	const tool = (await client.listTools()).tools.find((x) => x.name === "start_session")!;
	assert.doesNotMatch(tool.description ?? "", /scratch session/);
	for (const args of [{}, { worktree: true }]) {
		const refused = await client.callTool({ name: "start_session", arguments: { task: "Sketch an idea", ...args } });
		assert.equal(refused.isError, true);
		assert.match(text(refused), /only worktree sessions \(mcp.worktreeOnly\), and a worktree needs a project/);
	}
	assert.deepEqual(await host.sessions.list(), [], "nothing was made");
});

test("without worktreeOnly, worktree: true without a project is refused rather than made a scratch sandbox", async (t) => {
	const { host, connect } = await mcp(t, true, { sandboxes: true });
	const client = await connect();
	const refused = await client.callTool({ name: "start_session", arguments: { task: "Sketch an idea", worktree: true } });
	assert.equal(refused.isError, true);
	assert.match(text(refused), /a worktree needs a project/);
	assert.deepEqual(await host.sessions.list(), []);
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

test("mcp.write, mcp.sandboxOnly, mcp.worktreeOnly, mcp.ship and mcp.shipWorktrees come from the settings file, are off by default, and sandboxOnly and worktreeOnly can't both be on", () => {
	const workspaces = [{ name: "a", roots: [] }];
	assert.deepEqual(configFor(JSON.stringify({ workspaces }), {}).config.mcp, { write: false, sandboxOnly: false, worktreeOnly: false, ship: false, shipWorktrees: false, allowNewProjects: false, writePlans: false });
	assert.deepEqual(configFor(JSON.stringify({ workspaces, mcp: { write: true } }), {}).config.mcp, { write: true, sandboxOnly: false, worktreeOnly: false, ship: false, shipWorktrees: false, allowNewProjects: false, writePlans: false });
	assert.deepEqual(configFor(JSON.stringify({ workspaces, mcp: { write: true, sandboxOnly: true } }), {}).config.mcp, { write: true, sandboxOnly: true, worktreeOnly: false, ship: false, shipWorktrees: false, allowNewProjects: false, writePlans: false });
	assert.deepEqual(configFor(JSON.stringify({ workspaces, mcp: { write: true, worktreeOnly: true } }), {}).config.mcp, { write: true, sandboxOnly: false, worktreeOnly: true, ship: false, shipWorktrees: false, allowNewProjects: false, writePlans: false });
	assert.deepEqual(configFor(JSON.stringify({ workspaces, mcp: { write: true, sandboxOnly: true, ship: true, shipWorktrees: true } }), {}).config.mcp, { write: true, sandboxOnly: true, worktreeOnly: false, ship: true, shipWorktrees: true, allowNewProjects: false, writePlans: false });
	assert.equal(configFor(JSON.stringify({ workspaces, mcp: { write: true, allowNewProjects: true } }), {}).config.mcp.allowNewProjects, true);
	assert.equal(configFor(JSON.stringify({ workspaces, mcp: { write: true, writePlans: true } }), {}).config.mcp.writePlans, true);
	assert.match(configFor(JSON.stringify({ workspaces, mcp: { writePlans: "yes" } }), {}).errors.join("\n"), /writePlans/);
	assert.match(configFor(JSON.stringify({ workspaces, mcp: { allowNewProjects: "yes" } }), {}).errors.join("\n"), /allowNewProjects/);
	assert.match(configFor(JSON.stringify({ workspaces, mcp: { sandboxOnly: "yes" } }), {}).errors.join("\n"), /sandboxOnly/);
	assert.match(configFor(JSON.stringify({ workspaces, mcp: { sandboxOnly: true, worktreeOnly: true } }), {}).errors.join("\n"), /both on/);
});

test("a long transcript keeps its latest items", () => {
	const items = Array.from({ length: 100 }, (_, i) => ({ kind: "user" as const, id: String(i), text: `message ${i} ${"x".repeat(100)}`, at: i }));
	const shown = transcriptText(items, 2000);
	assert.match(shown, /^\(\d+ earlier items left out\)/);
	assert.match(shown, /message 99/);
	assert.doesNotMatch(shown, /message 0 /);
});

type Gate = { wake: boolean; topic: string; through?: number; data: { change: number; id: number; from: string | null; to: string; transition: string; title: string; project: string; updated: string; agent: string; question?: { text: string; options: string[] } }[] };
// data comes as JSON text, as a gate's must; read back into entries here.
const check = async (client: Client): Promise<Gate> => {
	const answer = JSON.parse(text(await client.callTool({ name: "check_sessions", arguments: {} })));
	if (answer.data !== undefined) assert.equal(typeof answer.data, "string", "a gate's data is text");
	return { ...answer, data: answer.data === undefined ? [] : JSON.parse(answer.data) };
};

test("check_sessions wakes on a new session and on each run's end, and moves no cursor", async (t) => {
	const { host, project, connect, reader, bearer } = await mcp(t, false);
	const client = await connect(bearer(reader.secret));
	assert.deepEqual(JSON.parse(text(await client.callTool({ name: "check_sessions", arguments: {} }))), { wake: false, topic: "" }, "nothing yet, and no data");

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


/** The faux session for shipping: "commit NAME" commits NAME.txt; a ship prompt rebases onto refs/aludra/base and says SHIP-READY, or SHIP-BLOCKED when its note says block. */
const SHIPPING: FauxResponseStep[] = Array.from({ length: 40 }, () => (ctx: TranscriptContext) => {
	const last = ctx.messages.at(-1);
	const user = JSON.stringify(ctx.messages.findLast((m) => m.role === "user")?.content ?? "");
	if (/refs\/aludra\/base/.test(user)) {
		if (/note from the user[^\\]*block/.test(user)) return fauxAssistantMessage(fauxText("A conflict needs you.\nSHIP-BLOCKED: which title to keep"));
		if (last?.role === "toolResult") return fauxAssistantMessage(fauxText("Rebased and tested.\nSHIP-READY"));
		return fauxAssistantMessage(fauxToolCall("bash", { command: "git rebase -q refs/aludra/base 2>&1" }), { stopReason: "toolUse" });
	}
	if (last?.role === "toolResult") return fauxAssistantMessage(fauxText("Committed."));
	const name = /commit (\w+)/.exec(user)?.[1];
	if (name !== undefined) return fauxAssistantMessage(fauxToolCall("bash", { command: `echo ${name} > ${name}.txt && git add ${name}.txt && git -c user.name=t -c user.email=t@example.com commit -q -m ${name}` }), { stopReason: "toolUse" });
	return fauxAssistantMessage(fauxText("ok"));
});

test("ship_session is there only with mcp.write and mcp.ship, for a write token", async (t) => {
	const off = await mcp(t, true, { sandboxes: true });
	assert.deepEqual((await (await off.connect()).listTools()).tools.map((tool) => tool.name).sort(), WRITE_TOOLS, "mcp.ship off");
	const on = await mcp(t, true, { sandboxes: true, ship: true, shipWorktrees: false });
	assert.deepEqual((await (await on.connect()).listTools()).tools.map((tool) => tool.name).sort(), [...WRITE_TOOLS, "ship_session"].sort());
	assert.deepEqual((await (await on.connect(on.bearer(on.reader.secret))).listTools()).tools.map((tool) => tool.name).sort(), READ_TOOLS, "a read token");
	const noWrite = await mcp(t, false, { sandboxes: true, ship: true, shipWorktrees: false });
	assert.ok(!(await (await noWrite.connect()).listTools()).tools.some((tool) => tool.name === "ship_session"), "mcp.ship without mcp.write");
});

test("ship_session lands a sandbox session's work on the upstream, and check_sessions and list_sessions say how it went", async (t) => {
	const { host, project, remote, connect } = await mcp(t, true, { sandboxes: true, ship: true, remote: true, responses: SHIPPING });
	const client = await connect();
	const boxed = await host.sessions.createSandbox(project, "Feature");
	await (await host.submit(boxed.id, "commit feature")).wait(context);
	await idle(host, boxed.id);
	// Handled up to now, so the next change check_sessions gives is the ship's.
	const before = JSON.parse(text(await client.callTool({ name: "check_sessions", arguments: {} })));
	if (before.through !== undefined) await client.callTool({ name: "mark_sessions_handled", arguments: { through: before.through } });

	const started = JSON.parse(text(await client.callTool({ name: "ship_session", arguments: { id: boxed.id } })));
	assert.deepEqual(started, { id: boxed.id, started: true, to: "main" });
	const again = await client.callTool({ name: "ship_session", arguments: { id: boxed.id } });
	assert.equal(again.isError, true);
	assert.match(text(again), /already shipping|is running/);
	await until(async () => (await host.sessions.get(boxed.id))?.shipped !== undefined, "the ship to land");
	assert.equal(git(remote!, "log", "-1", "--format=%s", "main"), "feature", "pushed to the upstream's main");

	await until(async () => {
		const checked = JSON.parse(text(await client.callTool({ name: "check_sessions", arguments: {} })));
		if (!checked.wake) return false;
		const entry = (JSON.parse(checked.data) as { id: number; ship?: { shipped: boolean; line: string; commits: number } }[]).find((e) => e.id === boxed.id);
		return entry?.ship?.shipped === true && entry.ship.commits === 1 && entry.ship.line.startsWith("Shipped to main · 1 commit");
	}, "check_sessions to report the ship");
	const listed = JSON.parse(text(await client.callTool({ name: "list_sessions", arguments: {} }))) as { id: number; ship?: { shipped: boolean } }[];
	assert.equal(listed.find((s) => s.id === boxed.id)?.ship?.shipped, true);
	assert.match(text(await client.callTool({ name: "read_session", arguments: { id: boxed.id } })), /\nShip: Shipped to main · 1 commit/);
});

test("a blocked ship says so and pushes nothing, and ship_session refuses a local session and an unknown one", async (t) => {
	const { host, project, remote, connect } = await mcp(t, true, { sandboxes: true, ship: true, remote: true, responses: SHIPPING });
	const client = await connect();
	const boxed = await host.sessions.createSandbox(project, "Feature");
	await (await host.submit(boxed.id, "commit feature")).wait(context);
	await idle(host, boxed.id);
	const upstream = git(remote!, "rev-parse", "main");
	await client.callTool({ name: "ship_session", arguments: { id: boxed.id, note: "block it" } });
	await until(async () => (await host.sessions.get(boxed.id))?.shipStopped !== undefined, "the ship to stop");
	assert.equal(git(remote!, "rev-parse", "main"), upstream, "nothing pushed");
	const listed = JSON.parse(text(await client.callTool({ name: "list_sessions", arguments: {} }))) as { id: number; ship?: { shipped: boolean; kind: string; line: string } }[];
	const ship = listed.find((s) => s.id === boxed.id)?.ship;
	assert.equal(ship?.shipped, false);
	assert.equal(ship?.kind, "blocked");
	assert.equal(ship?.line, "Ship stopped · which title to keep");

	const local = await host.sessions.create(project, "Local");
	const refusedLocal = await client.callTool({ name: "ship_session", arguments: { id: local.id } });
	assert.equal(refusedLocal.isError, true);
	assert.match(text(refusedLocal), /isn't in a sandbox/);
	const unknown = await client.callTool({ name: "ship_session", arguments: { id: 999 } });
	assert.equal(unknown.isError, true);
	assert.match(text(unknown), /No session 999/);
});

/** SHIPPING for a worktree session: the ship prompt names refs/worktree/aludra/base, which the session rebases onto. */
const SHIPPING_WORKTREE: FauxResponseStep[] = Array.from({ length: 40 }, () => (ctx: TranscriptContext) => {
	const last = ctx.messages.at(-1);
	const user = JSON.stringify(ctx.messages.findLast((m) => m.role === "user")?.content ?? "");
	if (/refs\/worktree\/aludra\/base/.test(user)) {
		if (last?.role === "toolResult") return fauxAssistantMessage(fauxText("Rebased.\nSHIP-READY"));
		return fauxAssistantMessage(fauxToolCall("bash", { command: "git rebase -q refs/worktree/aludra/base 2>&1" }), { stopReason: "toolUse" });
	}
	if (last?.role === "toolResult") return fauxAssistantMessage(fauxText("Committed."));
	const name = /commit (\w+)/.exec(user)?.[1];
	if (name !== undefined) return fauxAssistantMessage(fauxToolCall("bash", { command: `echo ${name} > ${name}.txt && git add ${name}.txt && git -c user.name=t -c user.email=t@example.com commit -q -m ${name}` }), { stopReason: "toolUse" });
	return fauxAssistantMessage(fauxText("ok"));
});

test("ship_session ships a worktree session with mcp.shipWorktrees: pushed from the checkout, and check_sessions says so", async (t) => {
	const { host, project, remote, connect } = await mcp(t, true, { worktreeOnly: true, shipWorktrees: true, git: true, remote: true, responses: SHIPPING_WORKTREE });
	const client = await connect();
	const tools = (await client.listTools()).tools;
	assert.match(tools.find((tool) => tool.name === "ship_session")?.description ?? "", /^Ship a worktree session's work\. A worktree session .*pushes it to the upstream branch from the project's checkout/);
	const started = JSON.parse(text(await client.callTool({ name: "start_session", arguments: { project: "site", task: "commit feature" } })));
	await until(async () => (await host.sessions.states()).get(started.id) === "idle" && git(project.dir, "log", "-1", "--format=%s", "worktree/0") === "feature", "the session's commit");
	const before = JSON.parse(text(await client.callTool({ name: "check_sessions", arguments: {} })));
	if (before.through !== undefined) await client.callTool({ name: "mark_sessions_handled", arguments: { through: before.through } });

	assert.deepEqual(JSON.parse(text(await client.callTool({ name: "ship_session", arguments: { id: started.id } }))), { id: started.id, started: true, to: "main" });
	await until(async () => (await host.sessions.get(started.id))?.shipped !== undefined || (await host.sessions.get(started.id))?.shipStopped !== undefined, "the ship to end");
	const record = await host.sessions.get(started.id);
	assert.equal(record?.shipStopped, undefined, record?.shipStopped?.reason ?? "");
	assert.equal(git(remote!, "log", "-1", "--format=%s", "main"), "feature", "pushed to the upstream's main");
	assert.equal(git(project.dir, "rev-parse", "main"), git(remote!, "rev-parse", "main"), "the checkout's main fast-forwarded");
	await until(async () => {
		const checked = JSON.parse(text(await client.callTool({ name: "check_sessions", arguments: {} })));
		if (!checked.wake) return false;
		const entry = (JSON.parse(checked.data) as { id: number; ship?: { shipped: boolean; line: string } }[]).find((e) => e.id === started.id);
		return entry?.ship?.shipped === true && entry.ship.line.startsWith("Shipped to main · 1 commit");
	}, "check_sessions to report the ship");
});

test("mcp.ship and mcp.shipWorktrees each ship only their own kind of session", async (t) => {
	const worktrees = await mcp(t, true, { shipWorktrees: true, sandboxes: true });
	const wClient = await worktrees.connect();
	const boxed = await worktrees.host.sessions.createSandbox(worktrees.project, "Boxed");
	const refusedBox = await wClient.callTool({ name: "ship_session", arguments: { id: boxed.id } });
	assert.equal(refusedBox.isError, true);
	assert.match(text(refusedBox), /is in a sandbox, and this host ships only worktree sessions over MCP \(mcp.ship is off\)/);

	const sandboxes = await mcp(t, true, { ship: true, git: true });
	const sClient = await sandboxes.connect();
	const tree = await sandboxes.host.sessions.createWorktree(sandboxes.project, "Tree");
	const refusedTree = await sClient.callTool({ name: "ship_session", arguments: { id: tree.id } });
	assert.equal(refusedTree.isError, true);
	assert.match(text(refusedTree), /is in a worktree, and this host ships only sandbox sessions over MCP \(mcp.shipWorktrees is off\)/);
	const local = await sandboxes.host.sessions.create(sandboxes.project, "Local");
	assert.match(text(await sClient.callTool({ name: "ship_session", arguments: { id: local.id } })), /isn't in a sandbox, and only a sandbox session's work ships/);

	const neither = await mcp(t, true, { git: true });
	assert.ok(!(await (await neither.connect()).listTools()).tools.some((tool) => tool.name === "ship_session"));
	const noWrite = await mcp(t, false, { shipWorktrees: true, git: true });
	assert.ok(!(await (await noWrite.connect()).listTools()).tools.some((tool) => tool.name === "ship_session"), "mcp.shipWorktrees without mcp.write");
});

/** Replies that commit NAME.txt for "commit NAME", so a scratch sandbox has work to make a project of. */
const COMMITTING: FauxResponseStep[] = Array.from({ length: 40 }, () => (ctx: TranscriptContext) => {
	const last = ctx.messages.at(-1);
	if (last?.role === "toolResult") return fauxAssistantMessage(fauxText("Committed."));
	const name = /commit (\w+)/.exec(JSON.stringify(last?.content ?? ""))?.[1];
	if (name !== undefined) return fauxAssistantMessage(fauxToolCall("bash", { command: `echo ${name} > ${name}.txt && git add ${name}.txt && git -c user.name=t -c user.email=t@example.com commit -q -m ${name}` }), { stopReason: "toolUse" });
	if (/sleep/.test(JSON.stringify(last?.content ?? ""))) return fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 30" }), { stopReason: "toolUse" });
	return fauxAssistantMessage(fauxText("Done that."));
});

const json = (result: unknown) => JSON.parse(text(result));

test("mcp.allowNewProjects off: create_project and promote_session aren't offered, and the instructions say so", async (t) => {
	const { host, connect, gh } = await mcp(t, true, { sandboxes: true, newProjects: true });
	const client = await connect();
	assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), WRITE_TOOLS);
	assert.match(client.getInstructions() ?? "", /Making projects is off here \(mcp.allowNewProjects\)/);
	const refused = await client.callTool({ name: "create_project", arguments: { name: "waygate" } });
	assert.equal(refused.isError, true);
	assert.match(text(refused), /create_project not found/);
	assert.deepEqual(host.projectRequests.list(), []);
	assert.ok(!gh!.calls.some((c) => c[1] === "create"), "no repository was made");
});

test("mcp.allowNewProjects on: a read token still has neither tool, and a write token has both", async (t) => {
	const { connect, reader, bearer } = await mcp(t, true, { sandboxes: true, newProjects: true, allowNewProjects: true });
	const names = async (client: Client) => (await client.listTools()).tools.map((tool) => tool.name);
	assert.ok(!(await names(await connect(bearer(reader.secret)))).includes("create_project"));
	const writer = await connect();
	assert.ok((await names(writer)).includes("create_project") && (await names(writer)).includes("promote_session"));
	assert.match(writer.getInstructions() ?? "", /wait for the owner's approval/);
});

test("create_project makes nothing until it's approved, then makes the project and lists it at once", async (t) => {
	const { host, connect, dir, gh } = await mcp(t, true, { newProjects: true, allowNewProjects: true });
	const client = await connect();
	const asked = json(await client.callTool({ name: "create_project", arguments: { name: "waygate", description: "Gates." } }));
	assert.equal(asked.status, "pending");
	assert.match(asked.message, new RegExp(`aludra approve ${asked.request}`));
	const folder = join(dir, "Projects", "Software", "waygate");
	assert.ok(!existsSync(folder), "no folder before the approval");
	assert.ok(!gh!.calls.some((c) => c[1] === "create"), "no repository before the approval");
	assert.deepEqual(host.projectRequests.list().map((r) => [r.id, r.kind, r.name]), [[asked.request, "create", "waygate"]]);
	// Asking again while it waits is the same request, not a second one.
	assert.equal(json(await client.callTool({ name: "create_project", arguments: { name: "waygate" } })).request, asked.request);
	assert.equal(host.projectRequests.list().length, 1);

	const made = await host.projectRequests.decide(asked.request, true);
	assert.equal(made?.status, "done");
	assert.equal(made?.dir, folder);
	assert.equal(git(folder, "log", "-1", "--format=%s"), "Start waygate: Gates.");
	assert.ok(gh!.calls.some((c) => c[1] === "create" && c[2] === "t/waygate"), "the repository was made");
	const done = json(await client.callTool({ name: "create_project", arguments: { name: "waygate" } }));
	assert.equal(done.status, "done");
	assert.equal(done.project.dir, folder);
	assert.ok(json(await client.callTool({ name: "list_projects", arguments: {} })).some((p: { name: string }) => p.name === "waygate"), "list_projects has it at once");
	const started = json(await client.callTool({ name: "start_session", arguments: { project: "waygate", task: "Add a test" } }));
	assert.equal(started.project, "waygate");
	assert.deepEqual(host.projectRequests.list(), []);
	// The name is taken now.
	assert.match(text(await client.callTool({ name: "create_project", arguments: { name: "site" } })), /a project named site already/);
});

test("create_project denied or expired makes nothing, says so once, and asking again is a new request", async (t) => {
	const { host, connect, dir, gh, config } = await mcp(t, true, { newProjects: true, allowNewProjects: true });
	const client = await connect();
	const asked = json(await client.callTool({ name: "create_project", arguments: { name: "waygate" } }));
	assert.equal((await host.projectRequests.decide(asked.request, false))?.status, "denied");
	const denied = await client.callTool({ name: "create_project", arguments: { name: "waygate" } });
	assert.equal(denied.isError, true);
	assert.match(text(denied), new RegExp(`request ${asked.request} to make project waygate: the owner denied it, and nothing was made`));
	assert.ok(!existsSync(join(dir, "Projects", "Software", "waygate")));
	assert.ok(!gh!.calls.some((c) => c[1] === "create"));
	assert.equal(await host.projectRequests.decide(asked.request, true), undefined, "a denied request can't be approved after");

	const again = json(await client.callTool({ name: "create_project", arguments: { name: "waygate" } }));
	assert.equal(again.status, "pending");
	assert.notEqual(again.request, asked.request);

	// An expired one: the wait is read as each request is made.
	config.approvals.waitHours = 0.000001;
	const late = json(await client.callTool({ name: "create_project", arguments: { name: "late" } }));
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(await host.projectRequests.decide(late.request, true), undefined, "too late to approve");
	assert.match(text(await client.callTool({ name: "create_project", arguments: { name: "late" } })), /didn't answer in time, and nothing was made/);
	assert.ok(!existsSync(join(dir, "Projects", "Software", "late")));
});

test("create_project refuses a bad name, and without newProjects set says which settings it needs", async (t) => {
	const { host, connect } = await mcp(t, true, { allowNewProjects: true });
	const client = await connect();
	const missing = await client.callTool({ name: "create_project", arguments: { name: "waygate" } });
	assert.equal(missing.isError, true);
	assert.match(text(missing), /newProjects isn't set in the settings file \(newProjects.root and newProjects.owner\)/);
	assert.match(text(await client.callTool({ name: "create_project", arguments: { name: "Way Gate" } })), /isn't a project name/);
	assert.deepEqual(host.projectRequests.list(), [], "nothing waits for approval");
});

test("promote_session waits for approval, then makes a scratch session's work a project and the session its task", async (t) => {
	const { host, connect, gh } = await mcp(t, true, { sandboxes: true, newProjects: true, allowNewProjects: true, responses: COMMITTING });
	const client = await connect();
	const { id } = json(await client.callTool({ name: "start_session", arguments: { task: "commit idea" } }));
	await host.sandboxes.prepared(id);
	await until(async () => (await host.sessions.states()).get(id) === "idle" && (await readSummary(host, id))?.state === "done", "the commit");

	const asked = json(await client.callTool({ name: "promote_session", arguments: { id, name: "idea", description: "An idea." } }));
	assert.equal(asked.status, "pending");
	assert.equal(asked.session, id);
	assert.equal((await host.sessions.get(id))!.scratch, true, "still scratch before the approval");
	assert.ok(!gh!.calls.some((c) => c[1] === "create"));

	const made = await host.projectRequests.decide(asked.request, true);
	assert.equal(made?.status, "done", made?.error ?? "");
	assert.deepEqual(git(made!.dir!, "log", "--format=%s", "main").split("\n"), ["idea", "Scratch"]);
	const record = (await host.sessions.get(id))!;
	assert.equal(record.project, "idea");
	assert.equal(record.scratch, undefined);
	const done = json(await client.callTool({ name: "promote_session", arguments: { id, name: "idea" } }));
	assert.equal(done.status, "done");
	assert.equal(done.project.dir, made!.dir);
	// It's a project's session now, so a second promote is refused.
	assert.match(text(await client.callTool({ name: "promote_session", arguments: { id, name: "other" } })), /isn't a scratch sandbox session/);
});

test("promote_session refuses a running session, one that isn't a scratch sandbox, an unknown one, and without newProjects", async (t) => {
	const { host, project, connect } = await mcp(t, true, { sandboxes: true, newProjects: true, allowNewProjects: true, responses: COMMITTING });
	const client = await connect();
	const promote = (id: number) => client.callTool({ name: "promote_session", arguments: { id, name: "idea" } });

	const running = json(await client.callTool({ name: "start_session", arguments: { task: "sleep" } })).id;
	await host.sandboxes.prepared(running);
	await until(async () => (await host.sessions.states()).get(running) === "running", "the run");
	assert.match(text(await promote(running)), new RegExp(`session ${running} is running`));
	await host.stop(running);

	const local = await host.sessions.create(project, "Local");
	assert.match(text(await promote(local.id)), new RegExp(`session ${local.id} isn't a scratch sandbox session`));
	const boxed = json(await client.callTool({ name: "start_session", arguments: { project: "site", task: "Boxed", sandbox: true } })).id;
	assert.match(text(await promote(boxed)), new RegExp(`session ${boxed} isn't a scratch sandbox session`));
	assert.match(text(await promote(999)), /No session 999/);
	assert.deepEqual(host.projectRequests.list(), [], "nothing waits for approval");
});

test("promote_session without newProjects names the missing settings, and waiting sessions are refused", async (t) => {
	const { host, connect } = await mcp(t, true, { sandboxes: true, approvals: "ask", allowNewProjects: true, responses: SCRIPTED });
	const client = await connect();
	const done = json(await client.callTool({ name: "start_session", arguments: { task: "Sketch" } })).id;
	await host.sandboxes.prepared(done);
	await until(async () => (await readSummary(host, done))?.state === "done" && (await host.sessions.states()).get(done) === "idle", "the run");
	assert.match(text(await client.callTool({ name: "promote_session", arguments: { id: done, name: "idea" } })), /newProjects isn't set in the settings file/);

	const waiting = json(await client.callTool({ name: "start_session", arguments: { task: "push it" } })).id;
	await host.sandboxes.prepared(waiting);
	await until(async () => (await host.sessions.states()).get(waiting) === "waiting", "the approval");
	assert.match(text(await client.callTool({ name: "promote_session", arguments: { id: waiting, name: "idea" } })), new RegExp(`session ${waiting} is waiting for approval`));
	assert.deepEqual(host.projectRequests.list(), []);
});

test("aludra approvals lists a project request, and POST /api/approvals/:id answers it", async (t) => {
	const { host, url, connect, dir } = await mcp(t, true, { newProjects: true, allowNewProjects: true });
	const client = await connect();
	const asked = json(await client.callTool({ name: "create_project", arguments: { name: "waygate" } }));
	const answer = await fetch(`${url}/api/approvals/${asked.request}`, { method: "POST", headers: { "tailscale-user-login": USER, "content-type": "application/json" }, body: JSON.stringify({ allow: true }) });
	assert.equal(answer.status, 200);
	assert.deepEqual(await answer.json(), { status: "done", dir: join(dir, "Projects", "Software", "waygate") });
	const again = await fetch(`${url}/api/approvals/${asked.request}`, { method: "POST", headers: { "tailscale-user-login": USER, "content-type": "application/json" }, body: JSON.stringify({ allow: true }) });
	assert.equal(again.status, 409);
	assert.equal(host.projectRequests.list().length, 0);
});

test("worktreeOnly with mcp.allowNewProjects offers create_project but not promote_session, which has no scratch session to act on", async (t) => {
	const { host, connect, gh } = await mcp(t, true, { worktreeOnly: true, git: true, newProjects: true, allowNewProjects: true });
	const client = await connect();
	const names = (await client.listTools()).tools.map((tool) => tool.name);
	assert.ok(names.includes("create_project"));
	assert.ok(!names.includes("promote_session"));
	assert.match(client.getInstructions() ?? "", /Every session here needs a project/);
	assert.doesNotMatch(client.getInstructions() ?? "", /promote_session|scratch/);
	const asked = json(await client.callTool({ name: "create_project", arguments: { name: "waygate" } }));
	assert.equal(asked.status, "pending");
	assert.ok(!gh!.calls.some((c) => c[1] === "create"), "nothing is made before approval");
	assert.equal(host.projectRequests.list().length, 1);
});
