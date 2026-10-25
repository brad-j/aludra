import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { claudeConfigDir, configFor, defaultConfigFile, defaultDataDir, loadConfig } from "../src/config.ts";
import { expandRoot, findProject, findProjects } from "../src/projects.ts";
import { tempDir } from "./helpers.ts";

test("without a file, the settings are the defaults, and say a workspace is needed", () => {
	const { config, errors } = configFor(undefined, {}, "linux");
	assert.equal(errors.length, 1);
	assert.match(errors[0]!, /no workspaces/);
	assert.deepEqual(config.workspaces, []);
	assert.deepEqual(config.model, { provider: "claude-bridge", id: "claude-opus-5-5", thinking: "high", choices: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"].map((id) => ({ provider: "claude-bridge", id })) });
	assert.deepEqual(config.claude, { path: "claude" });
	assert.deepEqual(config.api, { port: 8724, users: [] });
	assert.deepEqual(config.approvals, { hosts: [], waitHours: 24 });
	assert.equal(config.dataDir, join(homedir(), ".local/share/aludra"));
	assert.deepEqual(config.backup, { dir: join(homedir(), ".local/share/aludra/backups"), everyHours: 24, keep: 7 });
	assert.equal(configFor(JSON.stringify({ backup: { dir: "~/nas/aludra", keep: 3 } }), {}).config.backup.dir, join(homedir(), "nas/aludra"));
});

test("the data and settings directories follow the platform and XDG", () => {
	assert.equal(defaultDataDir({}, "darwin"), join(homedir(), "Library/Application Support/aludra"));
	assert.equal(defaultDataDir({ XDG_DATA_HOME: "/data" }, "linux"), "/data/aludra");
	assert.equal(defaultConfigFile({}), join(homedir(), ".config/aludra/config.json"));
	assert.equal(defaultConfigFile({ XDG_CONFIG_HOME: "/conf" }), "/conf/aludra/config.json");
	assert.match(loadConfig(undefined, { XDG_CONFIG_HOME: "/nonexistent" }).errors[0]!, /no settings file at \/nonexistent\/aludra\/config.json/);
});

test("a file's settings go over the defaults, and the environment over both", () => {
	const workspaces = [{ name: "code", roots: ["~/code/*"] }];
	const { config, errors } = configFor(JSON.stringify({ workspaces, model: { thinking: "xhigh" }, claude: { path: "~/bin/claude" }, api: { users: ["a@x", "b@x"] }, dataDir: "~/aludra" }), { ALUDRA_MODEL: "faux" });
	assert.deepEqual(errors, []);
	assert.deepEqual(config.workspaces, workspaces);
	assert.deepEqual(config.model, { provider: "faux", id: "faux-1", thinking: "xhigh", choices: [{ provider: "faux", id: "faux-1" }] });
	assert.equal(config.claude.path, join(homedir(), "bin/claude"));
	assert.deepEqual(config.api.users, ["a@x", "b@x"]);
	assert.equal(config.dataDir, join(homedir(), "aludra"));
	assert.equal(configFor(undefined, { ALUDRA_DATA_DIR: "/tmp/x" }).config.dataDir, "/tmp/x");
});

test("claude.configDir picks Claude Code's login directory, over CLAUDE_CONFIG_DIR, and must exist", (t) => {
	const dir = tempDir(t);
	const workspaces = [{ name: "code", roots: ["~/code/*"] }];
	const set = configFor(JSON.stringify({ workspaces, claude: { configDir: dir } }), {});
	assert.deepEqual(set.errors, []);
	assert.equal(set.config.claude.configDir, dir);
	assert.equal(claudeConfigDir(set.config, { CLAUDE_CONFIG_DIR: "/elsewhere" }), dir);
	const unset = configFor(JSON.stringify({ workspaces }), {}).config;
	assert.equal(unset.claude.configDir, undefined);
	assert.equal(claudeConfigDir(unset, { CLAUDE_CONFIG_DIR: "/elsewhere" }), "/elsewhere");
	assert.equal(claudeConfigDir(unset, {}), join(homedir(), ".claude"));
	assert.equal(configFor(JSON.stringify({ workspaces, claude: { configDir: "~/x" } }), {}).config.claude.configDir, join(homedir(), "x"));
	const missing = configFor(JSON.stringify({ workspaces, claude: { configDir: join(dir, "nope") } }), {});
	assert.match(missing.errors.join("\n"), /claude.configDir .*nope isn't a directory/);
});

test("model choices name their provider, or are the default provider's; so does the default model", () => {
	const settings = (model: object) => configFor(JSON.stringify({ workspaces: [{ name: "a", roots: [] }], model }), {});
	const mixed = settings({ choices: ["claude-opus-5-5", "openai/gpt-6.1-sol"] });
	assert.deepEqual(mixed.errors, []);
	assert.deepEqual(mixed.config.model.choices, [{ provider: "claude-bridge", id: "claude-opus-5-5" }, { provider: "openai", id: "gpt-6.1-sol" }]);

	// The default goes first when it isn't listed.
	const openai = settings({ id: "openai/gpt-6.1-sol", choices: ["claude-sonnet-5-5"] });
	assert.deepEqual(openai.errors, []);
	assert.deepEqual([openai.config.model.provider, openai.config.model.id], ["openai", "gpt-6.1-sol"]);
	assert.deepEqual(openai.config.model.choices, [{ provider: "openai", id: "gpt-6.1-sol" }, { provider: "claude-bridge", id: "claude-sonnet-5-5" }]);

	// Bare IDs belong to model.provider when it's set.
	assert.deepEqual(settings({ provider: "openai", id: "gpt-6.1-sol", choices: ["gpt-6-luna"] }).config.model.choices, [{ provider: "openai", id: "gpt-6.1-sol" }, { provider: "openai", id: "gpt-6-luna" }]);

	assert.match(settings({ choices: ["mystery/model-1"] }).errors[0]!, /names no provider/);
	assert.match(settings({ provider: "claude-bridge", id: "openai/gpt-6.1-sol" }).errors[0]!, /isn't a claude-bridge model/);
	assert.match(settings({ choices: ["claude-opus-5-5", "faux/claude-opus-5-5"] }).errors[0]!, /two of model.choices are claude-opus-5-5/);
});

test("settings that don't read right are errors, not defaults", () => {
	assert.match(configFor(JSON.stringify({ model: { thinking: "lots" } }), {}).errors[0]!, /thinking/);
	assert.match(configFor("{", {}).errors[0]!, /isn't JSON/);
	assert.match(configFor(JSON.stringify({ workspaces: [{ name: "a", roots: [] }, { name: "a", roots: [] }] }), {}).errors[0]!, /share a name/);
	assert.match(configFor(JSON.stringify({ workspaces: [{ name: "a", roots: [] }], api: { user: "a@x" } }), {}).errors[0]!, /api.users, a list/);
	assert.match(loadConfig("/nonexistent/aludra.json", {}).errors[0]!, /no settings file/);
});

test("roots match directories, not files or hidden ones, and each match is a project", (t) => {
	const dir = tempDir(t);
	for (const path of ["Projects/Software/aludra", "Projects/Software/gaidin", "Projects/Electronics/aludra", "Projects/Software/.hidden", "Personal/trips"]) mkdirSync(join(dir, path), { recursive: true });
	writeFileSync(join(dir, "Projects/Software/notes.md"), "");
	assert.deepEqual(expandRoot(join(dir, "Projects/*/*")).map((p) => p.slice(dir.length + 1)), ["Projects/Electronics/aludra", "Projects/Software/aludra", "Projects/Software/gaidin"]);
	assert.deepEqual(expandRoot(join(dir, "Projects/Soft*/g*")).length, 1);
	assert.deepEqual(expandRoot(join(dir, "Missing/*")), []);

	const projects = findProjects([{ name: "code", roots: [join(dir, "Projects/*/*"), join(dir, "Personal/*")] }]);
	assert.deepEqual(projects.map((p) => p.path), ["Electronics/aludra", "Software/aludra", "Software/gaidin", "Personal/trips"]);
	assert.equal(findProject(projects, "gaidin").dir, join(dir, "Projects/Software/gaidin"));
	assert.equal(findProject(projects, "Electronics/aludra").dir, join(dir, "Projects/Electronics/aludra"));
	assert.equal(findProject(projects, join(dir, "Personal/trips")).name, "trips");
	assert.throws(() => findProject(projects, "aludra"), /could be Electronics\/aludra or Software\/aludra/);
	assert.throws(() => findProject(projects, "nope"), /no project nope/);
});
