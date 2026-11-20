import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { MAX_PLAN, planItems, planSha256, readPlan } from "../src/plans.ts";
import { makeProject, tempDir } from "./helpers.ts";

test("read_plan reads docs/plan.md from the working copy as it is now", async (t) => {
	const project = makeProject(tempDir(t), "site", { "docs/plan.md": "# Plan\n\n## Now\n" });
	const plan = await readPlan(project);
	assert.equal(plan.exists, true);
	assert.ok(plan.exists);
	assert.equal(plan.text, "# Plan\n\n## Now\n");
	assert.equal(plan.size, 15);
	assert.equal(plan.path, "docs/plan.md");
	assert.equal(plan.sha256, planSha256("# Plan\n\n## Now\n"));
	assert.ok(!Number.isNaN(Date.parse(plan.modified)));
	writeFileSync(join(project.dir, "docs/plan.md"), "# Plan\n\n## Now\n### edited: Not committed\n");
	const again = await readPlan(project);
	assert.ok(again.exists);
	assert.match(again.text, /edited: Not committed/);
});

test("a plan's items: each heading with an id under one of the five sections, with its status line's fields", () => {
	const text = [
		"# Plan", "", "Open work.", "",
		"## Now", "",
		"### pages-web-view: The apps' web view for published pages",
		"Kind: step · Needs: verin/pages-server, attachments · Run: aludra worktree",
		"The server side shipped.", "",
		"```markdown", "## Later", "### not-an-item: In a code block", "```", "",
		"### no-status: An item with prose first", "",
		"It has no status line.", "Kind: step", "",
		"## Next", "## Questions",
		"### push-bundle-id: New bundle id, or reuse Lan's?",
		"Kind: question", "",
		"## Notes", "### stray: Under a section the format doesn't have", "Kind: step", "",
		"## Later", "### Not an id: a heading without one", "#### deeper: Not an item", "",
		"## Done", "### mail-shadow: Gmail in shadow mode", "Kind: step · Done: 2026-11-14 eb4754e",
	].join("\n");
	assert.deepEqual(planItems(text), [
		{ id: "pages-web-view", title: "The apps' web view for published pages", section: "Now", kind: "step", needs: ["verin/pages-server", "attachments"], run: "aludra worktree" },
		{ id: "no-status", title: "An item with prose first", section: "Now" },
		{ id: "push-bundle-id", title: "New bundle id, or reuse Lan's?", section: "Questions", kind: "question" },
		{ id: "mail-shadow", title: "Gmail in shadow mode", section: "Done", kind: "step" },
	]);
	assert.deepEqual(planItems("# loial plan\n\n## Steps\n\n1. Post-mortem.\n\n## Later\n\nCandidates.\n"), [], "a plan in another format has no items");
	assert.deepEqual(planItems(""), []);
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
