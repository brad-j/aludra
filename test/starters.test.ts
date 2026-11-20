import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createNewProjects, NewProjectRefused } from "../src/new-projects.ts";
import { planItems, PLAN_SECTIONS } from "../src/plans.ts";
import { agentsText, checkSeed, itemId, planText } from "../src/starters.ts";
import { fakeGh, GIT_ENV, git, tempDir } from "./helpers.ts";

function setup(t: TestContext, designSeeds?: string) {
	const root = tempDir(t);
	const fake = fakeGh(join(root, "github"));
	process.env.GIT_AUTHOR_NAME ??= GIT_ENV.GIT_AUTHOR_NAME;
	return { root, made: createNewProjects({ root: join(root, "Projects"), owner: "t", ...fake, ...(designSeeds === undefined ? {} : { designSeeds }) }) };
}

/** The plan format's rules, as the plan skill states them. */
function checkFormat(text: string) {
	const sections = [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
	assert.deepEqual(sections, [...PLAN_SECTIONS]);
	const lines = text.split("\n");
	const ids: string[] = [];
	lines.forEach((line, i) => {
		if (!line.startsWith("### ")) return;
		const m = /^### ([a-z0-9][a-z0-9-]*): .+$/.exec(line);
		assert.ok(m, line);
		ids.push(m[1]!);
		assert.match(lines[i + 1]!, /^Kind: (step|question|request|chore)$/);
	});
	assert.equal(new Set(ids).size, ids.length);
}

test("an empty plan has the five sections and nothing else", () => {
	const text = planText("waygate");
	checkFormat(text);
	assert.deepEqual(planItems(text), []);
	assert.match(text, /^# Plan\n\nwaygate's open work\./);
});

test("a seeded plan puts the first step in Now, the rest in Next and the questions under Questions", () => {
	const text = planText("waygate", { steps: ["Build the first screen", "Add a settings page", "Build the first screen"], questions: ["Which stack?"] });
	checkFormat(text);
	assert.deepEqual(
		planItems(text).map((i) => [i.section, i.id, i.title, i.kind]),
		[
			["Now", "build-the-first-screen", "Build the first screen", "step"],
			["Next", "add-a-settings-page", "Add a settings page", "step"],
			["Next", "build-the-first-screen-2", "Build the first screen", "step"],
			["Questions", "which-stack", "Which stack?", "question"],
		],
	);
});

test("item ids are short kebab-case and unique; a seed is checked", () => {
	const taken = new Set<string>();
	assert.equal(itemId("What's the FIRST usable version, really, honestly?", taken), "what-s-the-first-usable");
	assert.equal(itemId("???", taken), "item");
	assert.equal(itemId("???", taken), "item-2");
	assert.deepEqual(checkSeed({ steps: ["  a \n b  ", ""], questions: [] }), { steps: ["a b"], questions: [] });
	assert.equal(checkSeed(undefined), undefined);
	assert.throws(() => checkSeed({ steps: "one" }), NewProjectRefused);
	assert.throws(() => checkSeed([]), NewProjectRefused);
	assert.throws(() => checkSeed({ steps: Array.from({ length: 41 }, (_, i) => `s${i}`) }), /more than 40/);
	assert.match(agentsText("waygate", "Gates."), /^# waygate\n\nGates\.\n\n- Open work is in \[docs\/plan\.md\]/);
});

test("a new project's first commit has AGENTS.md, CLAUDE.md and a seeded plan", async (t) => {
	const { made } = setup(t);
	const { dir } = await made.create("waygate", "A tool for gates.", undefined, { plan: { steps: ["Sketch it"], questions: ["Who is it for?"] } });
	assert.equal(git(dir, "show", "--name-only", "--format=", "HEAD").split("\n").sort().join(" "), "AGENTS.md CLAUDE.md README.md docs/plan.md");
	assert.equal(readFileSync(join(dir, "CLAUDE.md"), "utf8"), "@AGENTS.md\n");
	assert.match(readFileSync(join(dir, "AGENTS.md"), "utf8"), /^# waygate\n\nA tool for gates\./);
	assert.deepEqual(planItems(readFileSync(join(dir, "docs", "plan.md"), "utf8")).map((i) => i.id), ["sketch-it", "who-is-it-for"]);
	assert.equal(git(dir, "status", "--porcelain"), "");
});

test("a UI project gets the design seeds; without them it's refused before anything is made", async (t) => {
	const seeds = join(tempDir(t), "design");
	mkdirSync(seeds);
	writeFileSync(join(seeds, "DESIGN.md"), "# Design\n");
	writeFileSync(join(seeds, "PRODUCT.md"), "# Product\n");
	const { made } = setup(t, seeds);
	const { dir } = await made.create("site", undefined, undefined, { ui: true });
	assert.equal(readFileSync(join(dir, "DESIGN.md"), "utf8"), "# Design\n");
	assert.equal(readFileSync(join(dir, "PRODUCT.md"), "utf8"), "# Product\n");

	const without = setup(t);
	await assert.rejects(without.made.create("other", undefined, undefined, { ui: true }), /no newProjects.designSeeds/);
	assert.equal(existsSync(join(without.root, "Projects", "other")), false);
	await assert.rejects(without.made.create("other", undefined, undefined, { ui: "yes" as never }), /ui should be true or false/);
});

test("a promoted scratch session keeps its own commits, with no starter files added", async (t) => {
	const { root, made } = setup(t);
	const src = join(root, "src");
	mkdirSync(src);
	git(src, "init", "-q", "-b", "main");
	writeFileSync(join(src, "x.txt"), "x\n");
	git(src, "add", "x.txt");
	git(src, "commit", "-q", "-m", "work");
	const { dir } = await made.create("promoted", undefined, { source: src, ref: "refs/heads/main" });
	assert.equal(existsSync(join(dir, "AGENTS.md")), false);
});

test("the starter plan follows the plan skill's format, as tar-valon has it", { skip: !existsSync(join(homedir(), ".pi/agent/skills/plan/SKILL.md")) }, () => {
	const skill = readFileSync(join(homedir(), ".pi/agent/skills/plan/SKILL.md"), "utf8");
	for (const s of PLAN_SECTIONS) assert.match(skill, new RegExp(`\`${s}\``), `the skill names ${s}`);
	assert.match(skill, /### <id>: <title>/);
	assert.match(skill, /`step`, `question`, `request`, `chore`/);
});
