import assert from "node:assert/strict";
import test from "node:test";
import { hueIndex, type Project, projectColor, projectGroups, searchProjects } from "../app/lib/projects.ts";
import type { SessionSummary } from "../src/api-types.ts";

const project = (path: string): Project => ({ workspace: "code", name: path.split("/").at(-1)!, path, dir: `/w/${path}` });
const projects = ["Software/aludra", "Software/amyrlin", "Software/gaidin", "Software/gray-ajah", "Fabrication/keychain", "Fabrication/server-rack", "Electronics/esp32-projects", "Personal/Trips"].map(project);
const session = (id: number, path: string, updatedAt: number) => ({ id, dir: `/w/${path}`, updatedAt }) as SessionSummary;

test("project colours match the amyrlin Mac app's", () => {
	// The same values the Mac app's ProjectColorTests pin, so a project is one colour on both.
	assert.equal(hueIndex("aludra"), 6);
	assert.equal(hueIndex("waygate-cs"), 8);
	assert.equal(projectColor("amyrlin"), "oklch(80% 0.12 300)");
});

test("a picked colour wins over the name's, for that project only", () => {
	assert.equal(projectColor("aludra", { aludra: 0 }), "oklch(80% 0.12 300)");
	assert.equal(projectColor("amyrlin", { aludra: 2 }), "oklch(80% 0.12 300)");
	assert.equal(projectColor("aludra", { aludra: 99 }), projectColor("aludra"), "an index out of range falls back");
});

test("the picker shows Recent first, then folders largest first", () => {
	const groups = projectGroups(projects, [session(1, "Software/gaidin", 100), session(2, "Fabrication/keychain", 300), session(3, "Software/gaidin", 200)]);
	assert.deepEqual(groups.map((g) => g.title), ["Recent", "Software", "Fabrication", "Electronics", "Personal"]);
	assert.deepEqual(groups[0]!.entries.map((e) => [e.project.name, e.sessions, e.lastActive]), [["keychain", 1, 300], ["gaidin", 2, 200]]);
	assert.equal(projectGroups(projects, [])[0]!.title, "Software");
});

test("search ranks name prefixes first and keeps folders", () => {
	assert.deepEqual(searchProjects("a", projects, [])[0]!.entries.slice(0, 2).map((e) => e.project.name), ["aludra", "amyrlin"]);
	assert.deepEqual(searchProjects("fab key", projects, []).flatMap((g) => g.entries.map((e) => e.project.name)), ["keychain"]);
	assert.deepEqual(searchProjects("  ", projects, []), []);
});
