import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { MAX_PLAN, readPlan } from "../src/plans.ts";
import { makeProject, tempDir } from "./helpers.ts";

test("read_plan reads docs/plan.md from the working copy as it is now", async (t) => {
	const project = makeProject(tempDir(t), "site", { "docs/plan.md": "# Plan\n\n## Now\n" });
	const plan = await readPlan(project);
	assert.equal(plan.exists, true);
	assert.ok(plan.exists);
	assert.equal(plan.text, "# Plan\n\n## Now\n");
	assert.equal(plan.size, 15);
	assert.equal(plan.path, "docs/plan.md");
	assert.ok(!Number.isNaN(Date.parse(plan.modified)));
	writeFileSync(join(project.dir, "docs/plan.md"), "# Plan\n\n## Now\n### edited: Not committed\n");
	const again = await readPlan(project);
	assert.ok(again.exists);
	assert.match(again.text, /edited: Not committed/);
});

test("a project without a plan, or without docs, answers exists: false", async (t) => {
	const root = tempDir(t);
	assert.deepEqual(await readPlan(makeProject(root, "bare")), { project: "bare", path: "docs/plan.md", exists: false });
	const withDocs = makeProject(root, "docs-only", { "docs/design.md": "x" });
	assert.equal((await readPlan(withDocs)).exists, false);
	const fileDocs = makeProject(root, "file-docs", { docs: "not a directory" });
	assert.equal((await readPlan(fileDocs)).exists, false);
});

test("read_plan doesn't follow a symbolic link out of the project, and refuses a plan that isn't a file or is too big", async (t) => {
	const root = tempDir(t);
	writeFileSync(join(root, "secret"), "not a plan");
	const linked = makeProject(root, "linked", { "docs/design.md": "x" });
	symlinkSync(join(root, "secret"), join(linked.dir, "docs/plan.md"));
	await assert.rejects(readPlan(linked), /docs\/plan.md is a symbolic link/);
	const linkedDocs = makeProject(root, "linked-docs");
	mkdirSync(join(root, "elsewhere"));
	writeFileSync(join(root, "elsewhere/plan.md"), "elsewhere");
	symlinkSync(join(root, "elsewhere"), join(linkedDocs.dir, "docs"));
	await assert.rejects(readPlan(linkedDocs), /docs is a symbolic link/);
	const dir = makeProject(root, "dir", { "docs/plan.md/inner": "x" });
	await assert.rejects(readPlan(dir), /isn't a file/);
	const big = makeProject(root, "big", { "docs/plan.md": "x".repeat(MAX_PLAN + 1) });
	await assert.rejects(readPlan(big), /over read_plan's/);
});
