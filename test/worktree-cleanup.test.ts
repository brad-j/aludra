import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { context } from "../src/host.ts";
import { removeWorktreesOnArchive } from "../src/worktree-cleanup.ts";
import { git, gitProject, testHost } from "./helpers.ts";

async function worktreeHost(t: TestContext) {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	faux.setResponses(Array.from({ length: 20 }, () => fauxAssistantMessage(fauxText("done"))));
	const models = createModels();
	models.setProvider(faux.provider);
	const { host, dir } = await testHost(t, { models, model: { provider: "faux", modelId: "faux-1" } });
	const { project } = gitProject(dir, "site");
	const lines: string[] = [];
	const cleanup = removeWorktreesOnArchive(host, (line) => lines.push(line));
	t.after(() => cleanup.stop());
	const session = await host.sessions.createWorktree(project, "Work");
	await (await host.submit(session.id, "Work")).wait(context);
	while ((await host.sessions.states()).get(session.id) !== "idle") await new Promise((resolve) => setTimeout(resolve, 10));
	return { host, project, session, lines, cleanup };
}

test("archiving a worktree session removes its worktree and keeps its branch with its commits", async (t) => {
	const { host, project, session, lines, cleanup } = await worktreeHost(t);
	git(session.dir, "commit", "-q", "--allow-empty", "-m", "the session's work");
	await host.sessions.archive(session.id, true);
	await cleanup.settled();
	assert.equal(existsSync(session.dir), false, "the worktree is gone");
	assert.equal(git(project.dir, "log", "-1", "--format=%s", "worktree/0"), "the session's work", "the branch keeps its commits");
	assert.doesNotMatch(git(project.dir, "worktree", "list"), /worktree\/0|site-0/);
	assert.equal((await host.sessions.get(session.id))?.worktreeRemoved, true);
	assert.match(lines.join("\n"), /its worktree was removed; its commits are on worktree\/0/);
	assert.equal(git(project.dir, "rev-parse", "--abbrev-ref", "HEAD"), "main");
});

test("a worktree with uncommitted files is kept when its session is archived, and removed once they're committed", async (t) => {
	const { host, session, lines, cleanup } = await worktreeHost(t);
	writeFileSync(join(session.dir, "a.txt"), "changed\n");
	await host.sessions.archive(session.id, true);
	await cleanup.settled();
	assert.equal(existsSync(session.dir), true, "kept");
	assert.match(lines.join("\n"), /wasn't removed, kept: 1 uncommitted file in it/);
	git(session.dir, "commit", "-qam", "saved");
	await host.sessions.archive(session.id, false);
	await host.sessions.archive(session.id, true);
	await cleanup.settled();
	assert.equal(existsSync(session.dir), false, "removed once committed");
});

test("a session that isn't in a worktree is left alone", async (t) => {
	const { host, project } = await worktreeHost(t);
	const local = await host.sessions.create(project, "Here");
	assert.deepEqual(await host.sessions.removeWorktree(local.id), { removed: false, reason: "not a worktree session" });
	assert.equal(existsSync(project.dir), true);
});
