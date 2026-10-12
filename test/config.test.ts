import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configFor, loadConfig } from "../src/config.ts";
import { expandRoot, findProject, findProjects } from "../src/projects.ts";
import { tempDir } from "./helpers.ts";

test("without a file, the settings are the plan's defaults", () => {
	const { config, errors } = configFor(undefined, {});
	assert.deepEqual(errors, []);
	assert.deepEqual(config.workspaces, [{ name: "egwene", roots: ["~/westwood/Projects/*/*", "~/westwood/Personal/*"] }]);
	assert.deepEqual(config.model, { provider: "claude-bridge", id: "claude-opus-5-5", thinking: "high", choices: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"] });
	assert.deepEqual(config.api, { port: 8724 });
	assert.equal(config.dataDir, join(homedir(), ".local/share/aludra"));
});

test("a file's settings go over the defaults, and the environment over both", () => {
	const { config } = configFor(JSON.stringify({ model: { thinking: "xhigh" }, dataDir: "~/aludra" }), { ALUDRA_MODEL: "faux" });
	assert.deepEqual(config.model, { provider: "faux", id: "faux-1", thinking: "xhigh", choices: ["faux-1"] });
	assert.equal(config.dataDir, join(homedir(), "aludra"));
	assert.equal(configFor(undefined, { ALUDRA_DATA_DIR: "/tmp/x" }).config.dataDir, "/tmp/x");
});

test("settings that don't read right are errors, not defaults", () => {
	assert.match(configFor(JSON.stringify({ model: { thinking: "lots" } }), {}).errors[0]!, /thinking/);
	assert.match(configFor("{", {}).errors[0]!, /isn't JSON/);
	assert.match(configFor(JSON.stringify({ workspaces: [{ name: "a", roots: [] }, { name: "a", roots: [] }] }), {}).errors[0]!, /share a name/);
	assert.match(loadConfig("/nonexistent/aludra.json", {}).errors[0]!, /no settings file/);
});

test("roots match directories, not files or hidden ones, and each match is a project", (t) => {
	const dir = tempDir(t);
	for (const path of ["Projects/Software/aludra", "Projects/Software/gaidin", "Projects/Electronics/aludra", "Projects/Software/.hidden", "Personal/trips"]) mkdirSync(join(dir, path), { recursive: true });
	writeFileSync(join(dir, "Projects/Software/notes.md"), "");
	assert.deepEqual(expandRoot(join(dir, "Projects/*/*")).map((p) => p.slice(dir.length + 1)), ["Projects/Electronics/aludra", "Projects/Software/aludra", "Projects/Software/gaidin"]);
	assert.deepEqual(expandRoot(join(dir, "Projects/Soft*/g*")).length, 1);
	assert.deepEqual(expandRoot(join(dir, "Missing/*")), []);

	const projects = findProjects([{ name: "egwene", roots: [join(dir, "Projects/*/*"), join(dir, "Personal/*")] }]);
	assert.deepEqual(projects.map((p) => p.path), ["Electronics/aludra", "Software/aludra", "Software/gaidin", "Personal/trips"]);
	assert.equal(findProject(projects, "gaidin").dir, join(dir, "Projects/Software/gaidin"));
	assert.equal(findProject(projects, "Electronics/aludra").dir, join(dir, "Projects/Electronics/aludra"));
	assert.equal(findProject(projects, join(dir, "Personal/trips")).name, "trips");
	assert.throws(() => findProject(projects, "aludra"), /could be Electronics\/aludra or Software\/aludra/);
	assert.throws(() => findProject(projects, "nope"), /no project nope/);
});
