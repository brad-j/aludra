import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { WebSocket } from "ws";
import type { ServerEvent, Settings } from "../src/api-types.ts";
import { createApi } from "../src/api.ts";
import { context } from "../src/host.ts";
import { parseClientMessage } from "../src/server.ts";
import { changeSettings, describeSettings, renderSettings, SettingsError, valueFromWords, writeSettings } from "../src/settings.ts";
import { makeProject, tempDir, testHost } from "./helpers.ts";

const USER = "you@example.com";

/** A settings file in a temp directory holding `settings`. */
function settingsFile(t: TestContext, settings: object): string {
	const file = join(tempDir(t), "config.json");
	writeFileSync(file, JSON.stringify(settings));
	return file;
}

const find = (settings: Settings, key: string) => settings.settings.find((s) => s.key === key)!;

test("each setting describes itself: its value with defaults filled in, its default, whether the file sets it, and whether apps may change it", (t) => {
	const file = settingsFile(t, { workspaces: [{ name: "code", roots: ["~/code/*"] }], approvals: { hosts: ["db"] }, dataDir: "/srv/aludra" });
	const settings = describeSettings(file, undefined, {});
	assert.equal(settings.file, file);
	assert.deepEqual(settings.errors, []);
	assert.deepEqual(find(settings, "workspaces"), {
		key: "workspaces", label: "Workspaces", help: find(settings, "workspaces").help, kind: "workspaces", value: [{ name: "code", roots: ["~/code/*"] }], set: true, editable: true, live: true,
	});
	assert.deepEqual(find(settings, "approvals.hosts").value, ["db"]);
	assert.equal(find(settings, "approvals.hosts").set, true);
	assert.equal(find(settings, "approvals.waitHours").value, 24);
	assert.equal(find(settings, "approvals.waitHours").set, false);
	assert.equal(find(settings, "model.id").value, "claude-bridge/claude-opus-5-5");
	assert.deepEqual(find(settings, "model.thinking").options, ["off", "minimal", "low", "medium", "high", "xhigh"]);
	assert.equal(find(settings, "backup.dir").value, "/srv/aludra/backups");
	for (const key of ["api.users", "api.port", "claude.path", "dataDir"]) {
		assert.equal(find(settings, key).editable, false, key);
		assert.equal(find(settings, key).live, false, key);
	}
});

test("a change is written to the file with everything else in it kept, and null puts a setting back to its default", (t) => {
	const file = settingsFile(t, { workspaces: [{ name: "code", roots: ["~/code/*"] }], api: { users: ["you@example.com"] }, approvals: { hosts: ["db"] }, note: "kept" });
	const { text, config } = changeSettings(file, { "approvals.hosts": ["db", "router"], "backup.keep": 3, "model.thinking": "low" }, {});
	assert.deepEqual(config.approvals.hosts, ["db", "router"]);
	assert.equal(config.file, file);
	const raw = JSON.parse(text);
	assert.deepEqual(raw, { workspaces: [{ name: "code", roots: ["~/code/*"] }], api: { users: ["you@example.com"] }, approvals: { hosts: ["db", "router"] }, note: "kept", backup: { keep: 3 }, model: { thinking: "low" } });
	assert.match(text, /^{\n\t"workspaces"/, "tabs, as aludra init writes");

	writeSettings(file, text);
	const back = JSON.parse(changeSettings(file, { "approvals.hosts": null, "backup.keep": null }, {}).text);
	assert.equal(back.approvals, undefined, "an object left empty goes");
	assert.equal(back.backup, undefined);
	assert.deepEqual(back.model, { thinking: "low" });
});

test("a change is refused, whole, for a setting only the file changes, an unknown one, a value of the wrong shape, or settings the host wouldn't start with", (t) => {
	const file = settingsFile(t, { workspaces: [{ name: "code", roots: ["~/code/*"] }] });
	const refused = (changes: Record<string, unknown>, pattern: RegExp) =>
		assert.throws(() => changeSettings(file, changes as never, {}), (error: unknown) => error instanceof SettingsError && error.errors.some((e) => pattern.test(e)));
	refused({ "api.users": ["intruder@example.com"] }, /api.users changes only in the settings file/);
	refused({ dataDir: "/tmp" }, /dataDir changes only in the settings file/);
	refused({ "claude.path": "/tmp/evil" }, /claude.path changes only/);
	refused({ "no.such": 1 }, /there's no setting no.such/);
	refused({ "approvals.waitHours": "soon" }, /approvals.waitHours should be a number/);
	refused({ "approvals.hosts": ["ok", " "] }, /approvals.hosts\[1\] needs a name/);
	refused({ "model.thinking": "lots" }, /model.thinking should be/);
	refused({ workspaces: [] }, /no workspaces/);
	refused({ "approvals.waitHours": 0 }, /waitHours should be more than 0/);
	refused({ "model.choices": ["claude-bridge/a", "openai/a"] }, /two of model.choices are a/);
	refused({}, /no changes/);
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { workspaces: [{ name: "code", roots: ["~/code/*"] }] }, "nothing was written");
	assert.throws(() => changeSettings(undefined, { "backup.keep": 2 }, {}), /started without a settings file/);
});

test("saving follows a settings file that's a link, and keeps its permissions", (t) => {
	const dir = tempDir(t);
	mkdirSync(join(dir, "dotfiles"));
	const real = join(dir, "dotfiles", "aludra.json");
	writeFileSync(real, "{}");
	chmodSync(real, 0o640);
	const link = join(dir, "config.json");
	symlinkSync(real, link);
	writeSettings(link, '{ "a": 1 }\n');
	assert.ok(lstatSync(link).isSymbolicLink());
	assert.equal(readFileSync(real, "utf8"), '{ "a": 1 }\n');
	assert.equal(statSync(real).mode & 0o777, 0o640);
});

test("aludra config set takes words as a list's entries, numbers as numbers, and JSON for workspaces", (t) => {
	const settings = describeSettings(settingsFile(t, { workspaces: [{ name: "code", roots: ["~/code/*"] }] }), undefined, {});
	assert.deepEqual(valueFromWords(find(settings, "approvals.hosts"), ["db", "router"]), ["db", "router"]);
	assert.deepEqual(valueFromWords(find(settings, "approvals.hosts"), ['["db"]']), ["db"]);
	assert.equal(valueFromWords(find(settings, "backup.keep"), ["3"]), 3);
	assert.equal(valueFromWords(find(settings, "backup.keep"), ["three"]), "three");
	assert.equal(valueFromWords(find(settings, "backup.dir"), ["/mnt/my", "backups"]), "/mnt/my backups");
	assert.equal(valueFromWords(find(settings, "model.thinking"), ["low"]), "low");
	assert.deepEqual(valueFromWords(find(settings, "workspaces"), ['[{"name":"w","roots":["~/w/*"]}]']), [{ name: "w", roots: ["~/w/*"] }]);
	const lines = renderSettings(settings);
	assert.ok(lines.some((l) => /^approvals.hosts\s+none\s+\(default\)$/.test(l)), lines.join("\n"));
	assert.ok(lines.some((l) => /^api.users\s+none\s+\(default, file only\)$/.test(l)));
	assert.ok(lines.some((l) => /^workspaces\s+code: ~\/code\/\*$/.test(l)));
	assert.deepEqual(parseClientMessage('{"type":"settings","changes":{"backup.keep":2}}'), { type: "settings", changes: { "backup.keep": 2 } });
	assert.deepEqual(parseClientMessage('{"type":"settings"}'), { type: "settings" });
});

/** A faux model that runs `command` once, then answers with the result. */
function oneCommand(command: string) {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }, { id: "faux-2" }] });
	faux.setResponses(Array.from({ length: 20 }, () => (ctx: TranscriptContext) => {
		const last = ctx.messages.at(-1);
		if (last?.role === "toolResult") return fauxAssistantMessage(fauxText(`result: ${JSON.stringify(last.content)}`));
		return fauxAssistantMessage(fauxToolCall("bash", { command }), { stopReason: "toolUse" });
	}));
	const models = createModels();
	models.setProvider(faux.provider);
	return { models, model: { provider: "faux", modelId: "faux-1" } };
}

test("a running host takes saved changes at once: new projects, approval hosts, the default model and thinking", async (t) => {
	const { host, dir, config } = await testHost(t, { ...oneCommand("ssh new-box uptime || true"), settingsFile: true });
	makeProject(dir, "one");
	mkdirSync(join(dir, "elsewhere", "two"), { recursive: true });
	assert.deepEqual(host.projects().map((p) => p.name), ["one"]);
	let heard = 0;
	host.settings.onChange(() => heard++);

	const saved = host.settings.set({
		workspaces: [{ name: "test", roots: [join(dir, "Projects", "*", "*")] }, { name: "more", roots: [join(dir, "elsewhere", "*")] }],
		"approvals.hosts": ["new-box"],
		"model.id": "faux/faux-2",
		"model.thinking": "low",
	});
	assert.equal(heard, 1);
	assert.deepEqual(host.projects().map((p) => p.name).sort(), ["one", "two"]);
	assert.deepEqual(host.model, { provider: "faux", modelId: "faux-2" });
	assert.equal(host.thinking, "low");
	assert.deepEqual(JSON.parse(readFileSync(config.file!, "utf8")).approvals, { hosts: ["new-box"] });
	// The pinned Claude models came from the defaults; this host never loaded Claude Code, so they wait for a restart.
	assert.deepEqual(saved.restart, ["model.choices"]);

	const session = await host.sessions.create(host.projects().find((p) => p.name === "two")!, "check it");
	const run = await host.submit(session.id, "check it");
	let request;
	while ((request = (await host.approvals.pending())[0]) === undefined) await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(request.summary, "ssh to new-box");
	await host.approvals.decide(request.id, false);
	await run.wait(context);

	assert.throws(() => host.settings.set({ "model.id": "faux/nope" }), /faux\/nope isn't a model this host has/);
	assert.equal(heard, 1);
	// A model of a provider the host didn't load is saved, for the next start.
	const later = host.settings.set({ "model.id": "openai/gpt-6.1-sol" });
	assert.deepEqual(host.model, { provider: "faux", modelId: "faux-2" });
	assert.deepEqual(later.restart, ["model.id", "model.choices"]);
});

test("the API serves and saves the settings, refuses what only the file changes, and tells every app", async (t) => {
	const { host, config } = await testHost(t, { ...oneCommand("true"), settingsFile: true });
	const server = createApi(host, { users: [USER] });
	await new Promise<void>((resolve) => server.listen(0, resolve));
	t.after(() => server.close());
	const base = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;
	const call = (body?: unknown) => fetch(`${base}/api/settings`, body === undefined ? { headers: { "tailscale-user-login": USER } } : { method: "POST", headers: { "tailscale-user-login": USER, "content-type": "application/json" }, body: JSON.stringify(body) });
	const events: ServerEvent[] = [];
	const ws = new WebSocket(`${base.replace("http", "ws")}/api/live`, { headers: { "tailscale-user-login": USER } });
	t.after(() => ws.close());
	ws.on("message", (data) => events.push(JSON.parse(String(data))));
	await new Promise((resolve, reject) => ws.once("open", resolve).once("error", reject));

	const read = (await (await call()).json()) as Settings;
	assert.equal(read.file, config.file);
	assert.deepEqual(find(read, "approvals.hosts").value, ["build-box"]);

	const saved = (await (await call({ changes: { "approvals.hosts": ["db"], "backup.everyHours": 6 } })).json()) as Settings;
	assert.deepEqual(find(saved, "approvals.hosts").value, ["db"]);
	assert.equal(find(saved, "backup.everyHours").value, 6);
	assert.equal(config.backup.everyHours, 6, "the backup schedule reads it from the running settings");
	for (let i = 0; i < 100 && !events.some((e) => e.type === "settings"); i++) await new Promise((resolve) => setTimeout(resolve, 20));
	assert.ok(events.some((e) => e.type === "settings"));

	const refused = await call({ changes: { "api.users": ["intruder@example.com"] } });
	assert.equal(refused.status, 400);
	assert.match(await refused.text(), /api.users changes only in the settings file/);
	assert.equal((await call({ changes: { "backup.keep": 0 } })).status, 400);
	assert.equal((await fetch(`${base}/api/settings`)).status, 403, "no login, no settings");
	assert.equal((await fetch(`${base}/api/settings`, { method: "POST", headers: { "tailscale-user-login": USER, "content-type": "application/json", origin: "https://evil.example" }, body: '{"changes":{"backup.keep":2}}' })).status, 403);
});

test("amyrlin's endpoint has settings.get and settings.set, and a refused change is invalid_settings with every reason", async (t) => {
	const { host } = await testHost(t, { ...oneCommand("true"), settingsFile: true });
	const server = createApi(host, { users: [USER], name: "test-host" });
	await new Promise<void>((resolve) => server.listen(0, resolve));
	t.after(() => server.close());
	const ws = new WebSocket(`ws://127.0.0.1:${(server.server.address() as AddressInfo).port}/amyrlin`, { headers: { "tailscale-user-login": USER } });
	t.after(() => ws.close());
	const frames: { type: string; id?: string; result?: { settings: Settings }; error?: { code: string; data?: { errors: string[] } } }[] = [];
	ws.on("message", (data) => frames.push(JSON.parse(String(data))));
	await new Promise((resolve, reject) => ws.once("open", resolve).once("error", reject));
	const request = async (id: string, method: string, params: object = {}) => {
		ws.send(JSON.stringify({ type: "request", id, method, params }));
		for (;;) {
			const found = frames.find((f) => f.type === "response" && f.id === id);
			if (found !== undefined) return found;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	};
	ws.send(JSON.stringify({ type: "hello", protocols: [1], client: { name: "test", version: "0" } }));

	const got = await request("a", "settings.get");
	assert.ok(got.result!.settings.settings.some((s) => s.key === "workspaces"));
	const set = await request("b", "settings.set", { changes: { "approvals.waitHours": 2 } });
	assert.equal(find(set.result!.settings, "approvals.waitHours").value, 2);
	const refused = await request("c", "settings.set", { changes: { "api.port": 1, "backup.keep": -1 } });
	assert.equal(refused.error!.code, "invalid_settings");
	assert.equal(refused.error!.data!.errors.length, 1, "api.port is refused before the rest is checked");
	assert.equal((await request("d", "settings.set", { changes: [] })).error!.code, "bad_request");
});
