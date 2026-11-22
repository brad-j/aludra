import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { checkPlan, MAX_PLAN, PlanBusy, PlanConflict, PlanInvalid, planChanges, planItems, planSha256, readPlan, writePlan } from "../src/plans.ts";
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

const plan = (sections: Partial<Record<"Now" | "Next" | "Questions" | "Later" | "Done", string>> = {}) =>
	["# Plan", "", ...(["Now", "Next", "Questions", "Later", "Done"] as const).flatMap((s) => [`## ${s}`, ...(sections[s] === undefined ? [] : [sections[s]!]), ""])].join("\n");
const VALID = plan({
	Now: "### pages-view: The web view\nKind: step · Needs: verin/pages-server, mail-shadow · Run: aludra worktree\nProse.\n\n```markdown\n## Later\n### not-an-item\n```",
	Questions: "### bundle-id: Which bundle id?\nKind: question",
	Done: "### mail-shadow: Gmail in shadow mode\nKind: step · Done: 2026-11-14 eb4754e",
});

test("checkPlan passes a plan in the standard format, with code blocks and other repos' ids left alone", () => {
	assert.deepEqual(checkPlan(VALID), []);
	assert.deepEqual(checkPlan(plan()), [], "empty sections are fine");
	assert.deepEqual(checkPlan(VALID, VALID), []);
});

test("checkPlan wants exactly the five sections, in order", () => {
	assert.match(checkPlan("# Plan\n\n## Now\n## Later\n## Next\n## Questions\n## Done\n").join("\n"), /sections are "Now", "Later", "Next", "Questions", "Done"; a plan has exactly Now, Next, Questions, Later, Done/);
	assert.equal(checkPlan(plan().replace("## Questions\n", "")).length, 1, "a missing section");
	assert.equal(checkPlan(`${plan()}## Notes\n`).length, 1, "an extra section");
	assert.equal(checkPlan(`${plan()}## Done\n`).length, 1, "a section twice");
	assert.match(checkPlan("# Plan\n").join("\n"), /sections are none/);
});

test("checkPlan wants each ### heading to be a unique id and a title, under a section", () => {
	const bad = checkPlan(plan({ Now: "### Not an id: x\nKind: step\n\n### UPPER: x\nKind: step\n\n### no-title:\nKind: step\n\n### twice: A\nKind: step\n\n### twice: B\nKind: step" }));
	assert.equal(bad.filter((p) => /isn't "<id>: <title>"/.test(p)).length, 3, bad.join("\n"));
	assert.match(bad.join("\n"), /id twice is used already, on line \d+/);
	assert.match(checkPlan(`# Plan\n### early: Before Now\nKind: step\n\n${plan().slice("# Plan\n".length)}`).join("\n"), /isn't under one of the ## sections/);
});

test("checkPlan wants a Kind status line right under each heading", () => {
	const bad = checkPlan(plan({ Now: "### gap: A blank line first\n\nKind: step\n\n### prose: Prose first\nIt has none.\n\n### odd: Odd kind\nKind: epic\n\n### last: At the end" }));
	assert.equal(bad.filter((p) => /status line and starts with "Kind:/.test(p)).length, 3, bad.join("\n"));
	assert.match(bad.join("\n"), /odd's Kind is "epic"; it's one of step, question, request, chore/);
});

test("checkPlan wants every bare id in Needs to be an item here", () => {
	const bad = checkPlan(plan({ Now: "### a: A\nKind: step · Needs: b, other/c, missing" }));
	assert.deepEqual(bad.length, 2);
	assert.match(bad.join("\n"), /a needs b, which isn't an item/);
	assert.match(bad.join("\n"), /a needs missing/);
});

test("checkPlan refuses dropping an id the previous plan had, and a plan over MAX_PLAN", () => {
	const dropped = VALID.replace("### bundle-id: Which bundle id?\nKind: question", "");
	assert.match(checkPlan(dropped, VALID).join("\n"), /item bundle-id is missing; an id is never removed.*Move a dropped item to Done/);
	const moved = dropped.replace("## Done\n", "## Done\n### bundle-id: Which bundle id?\nKind: question · Done: 2026-11-19\nDropped: reusing Lan's.\n");
	assert.deepEqual(checkPlan(moved, VALID), []);
	assert.deepEqual(checkPlan(VALID, "# Old plan\n\n## Steps\n\n1. Something.\n"), [], "an old-format plan has no ids to keep");
	assert.match(checkPlan(VALID + "x".repeat(MAX_PLAN)).join("\n"), /bytes, over the 524288/);
	// Every problem at once.
	assert.equal(checkPlan(plan({ Now: "### Bad: x\nKind: step\n\n### a: A\nKind: nope" }).replace("## Later\n", ""), VALID).length, 4);
});

test("planChanges names the items added, removed, moved between sections and changed in place", () => {
	const next = plan({
		Now: "### pages-view: The web view, retitled\nKind: step · Needs: verin/pages-server, mail-shadow · Run: aludra worktree\nProse.",
		Later: "### new-one: New\nKind: chore",
		Done: "### bundle-id: Which bundle id?\nKind: question · Done: 2026-11-19\n\n### mail-shadow: Gmail in shadow mode\nKind: step · Done: 2026-11-14 eb4754e",
	});
	assert.deepEqual(planChanges(VALID, next), { added: ["new-one"], removed: [], moved: ["bundle-id"], changed: ["pages-view"] });
	assert.deepEqual(planChanges(next, next), { added: [], removed: [], moved: [], changed: [] });
	assert.deepEqual(planChanges("", VALID).added, ["pages-view", "bundle-id", "mail-shadow"]);
});

test("writePlan makes docs/ and the plan where there's none, and read_plan's sha256 is the base for the next", async (t) => {
	const project = makeProject(tempDir(t), "fresh");
	const made = await writePlan(project, VALID, null);
	assert.equal(made.sha256, planSha256(VALID));
	assert.equal(made.size, Buffer.byteLength(VALID));
	assert.deepEqual(made.items.added, ["pages-view", "bundle-id", "mail-shadow"]);
	const read = await readPlan(project);
	assert.ok(read.exists);
	assert.equal(read.text, VALID);
	assert.equal(read.sha256, made.sha256);
	assert.deepEqual(readdirSync(join(project.dir, "docs")), ["plan.md"], "no temporary file left behind");
	const next = VALID.replace("Prose.", "More prose.");
	assert.deepEqual((await writePlan(project, next, read.sha256)).items.changed, ["pages-view"]);
	assert.equal(readFileSync(join(project.dir, "docs/plan.md"), "utf8"), next);
});

test("writePlan refuses a stale base, null over a plan, and an invalid plan, writing nothing", async (t) => {
	const project = makeProject(tempDir(t), "site", { "docs/plan.md": VALID });
	const base = planSha256(VALID);
	await assert.rejects(writePlan(project, VALID, null), (e: unknown) => e instanceof PlanConflict && /has a docs\/plan.md now/.test(e.message));
	await assert.rejects(writePlan(project, VALID, planSha256("other")), (e: unknown) => e instanceof PlanConflict && /changed since it was read/.test(e.message));
	await assert.rejects(writePlan(project, "# Plan\n", base), (e: unknown) => e instanceof PlanInvalid && e.problems.length === 2);
	assert.equal(readFileSync(join(project.dir, "docs/plan.md"), "utf8"), VALID);
	assert.deepEqual(readdirSync(join(project.dir, "docs")), ["plan.md"]);
	const gone = makeProject(tempDir(t), "gone");
	await assert.rejects(writePlan(gone, VALID, base), (e: unknown) => e instanceof PlanConflict && /is gone since it was read/.test(e.message));
});

test("writePlan keeps the file's mode and serializes writes to a project, so the second of two from one base is refused", async (t) => {
	const project = makeProject(tempDir(t), "site", { "docs/plan.md": VALID });
	chmodSync(join(project.dir, "docs/plan.md"), 0o600);
	const base = planSha256(VALID);
	const results = await Promise.allSettled([writePlan(project, VALID.replace("Prose.", "One."), base), writePlan(project, VALID.replace("Prose.", "Two."), base)]);
	assert.equal(results[0]!.status, "fulfilled");
	assert.ok(results[1]!.status === "rejected" && results[1]!.reason instanceof PlanConflict);
	assert.match(readFileSync(join(project.dir, "docs/plan.md"), "utf8"), /One\./);
	assert.equal(statSync(join(project.dir, "docs/plan.md")).mode & 0o777, 0o600);
});

test("writePlan doesn't follow a symbolic docs or docs/plan.md", async (t) => {
	const root = tempDir(t);
	mkdirSync(join(root, "elsewhere"));
	writeFileSync(join(root, "elsewhere/plan.md"), VALID);
	const linkedDocs = makeProject(root, "linked-docs");
	symlinkSync(join(root, "elsewhere"), join(linkedDocs.dir, "docs"));
	await assert.rejects(writePlan(linkedDocs, VALID, planSha256(VALID)), /docs is a symbolic link/);
	await assert.rejects(writePlan(linkedDocs, VALID, null), /docs is a symbolic link/);
	const linked = makeProject(root, "linked", { "docs/design.md": "x" });
	symlinkSync(join(root, "elsewhere/plan.md"), join(linked.dir, "docs/plan.md"));
	await assert.rejects(writePlan(linked, VALID, planSha256(VALID)), /docs\/plan.md is a symbolic link/);
	assert.equal(readFileSync(join(root, "elsewhere/plan.md"), "utf8"), VALID, "the file outside is untouched");
});

test("writePlan asks its guard before writing and again just before the rename, and writes nothing when it refuses", async (t) => {
	const project = makeProject(tempDir(t), "site", { "docs/plan.md": VALID });
	const base = planSha256(VALID);
	let asked = 0;
	await assert.rejects(writePlan(project, VALID.replace("Prose.", "x"), base, async () => "session 3 (Busy) is running"), (e: unknown) => e instanceof PlanBusy && /session 3 \(Busy\) is running\. Nothing was written/.test(e.message));
	await assert.rejects(writePlan(project, VALID.replace("Prose.", "x"), base, async () => (++asked === 2 ? "a session started meanwhile" : undefined)), PlanBusy);
	assert.equal(asked, 2);
	assert.equal(readFileSync(join(project.dir, "docs/plan.md"), "utf8"), VALID);
	assert.deepEqual(readdirSync(join(project.dir, "docs")), ["plan.md"], "the temporary file is gone");
	await writePlan(project, VALID.replace("Prose.", "x"), base, async () => undefined);
	assert.match(readFileSync(join(project.dir, "docs/plan.md"), "utf8"), /x\n/);
});
