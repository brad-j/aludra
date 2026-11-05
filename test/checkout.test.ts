import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { parseStatus, readCheckout, watchCheckouts } from "../src/checkout.ts";
import { git, GIT_ENV, gitProject, tempDir } from "./helpers.ts";

test("git status's porcelain reads into branch, upstream, ahead, behind and dirty paths", () => {
	const text = ["# branch.oid 11c759b", "# branch.head main", "# branch.upstream origin/main", "# branch.ab +2 -3", "1 .M N... 100644 100644 100644 a b package.json", "? notes.txt", ""].join("\n");
	assert.deepEqual(parseStatus(text), { branch: "main", dirty: 2, ahead: 2, behind: 3, upstream: "origin/main", commits: true });
	assert.deepEqual(parseStatus("# branch.oid abc\n# branch.head (detached)\n"), { dirty: 0, ahead: 0, behind: 0, commits: true });
	assert.equal(parseStatus("# branch.oid (initial)\n# branch.head main\n").commits, false);
});

test("a checkout's ahead and behind are against the upstream as last fetched, and reading it never fetches", async (t) => {
	const root = tempDir(t);
	const { project, remote } = gitProject(root, "one", { "a.txt": "one\n" }, { remote: true });
	const other = join(root, "other");
	execFileSync("git", ["clone", "-q", remote!, other], { env: GIT_ENV });
	git(other, "commit", "-q", "--allow-empty", "-m", "theirs");
	git(other, "push", "-q", "origin", "main");
	git(project.dir, "commit", "-q", "--allow-empty", "-m", "mine");
	writeFileSync(join(project.dir, "a.txt"), "changed\n");
	writeFileSync(join(project.dir, "new.txt"), "new\n");

	const before = await readCheckout(project.dir, true);
	assert.deepEqual(before, { branch: "main", dirty: 2, ahead: 1, behind: 0, upstream: "origin/main", sandboxes: true, checks: 0, code: false });
	assert.equal(git(project.dir, "rev-parse", "origin/main"), git(project.dir, "rev-parse", "HEAD~1"), "nothing was fetched");
	git(project.dir, "fetch", "-q");
	assert.equal((await readCheckout(project.dir, true)).behind, 1);

	git(project.dir, "checkout", "-q", "--detach");
	assert.equal((await readCheckout(project.dir, true)).branch, undefined);
	assert.deepEqual((await readCheckout(project.dir, false)).sandboxes, { reason: "this host has no sandbox host" });
});

test("a project that isn't a repository of its own can't take a sandbox, and says why", async (t) => {
	const root = tempDir(t);
	const plain = join(root, "plain");
	mkdirSync(plain);
	assert.deepEqual(await readCheckout(plain, true), { dirty: 0, ahead: 0, behind: 0, sandboxes: { reason: "it isn't in git" }, checks: 0, code: false });
	const empty = join(root, "empty");
	mkdirSync(empty);
	git(empty, "init", "-q", "-b", "main");
	assert.deepEqual((await readCheckout(empty, true)).sandboxes, { reason: "it has no commits yet" });
	const { project } = gitProject(root, "outer");
	const inner = join(project.dir, "inner");
	mkdirSync(inner);
	assert.match(((await readCheckout(inner, true)).sandboxes as { reason: string }).reason, /inside the repository at/);
});

test("a checkout says what its last commit declares as checks, and whether it has code to check", async (t) => {
	const root = tempDir(t);
	const { project } = gitProject(root, "one", { "README.md": "# one\n" });
	assert.deepEqual(await readCheckout(project.dir, true).then(({ checks, code }) => ({ checks, code })), { checks: 0, code: false });
	writeFileSync(join(project.dir, "package.json"), "{}\n");
	assert.equal((await readCheckout(project.dir, true)).code, false, "an uncommitted manifest isn't in a sandbox");
	git(project.dir, "add", "-A");
	git(project.dir, "commit", "-q", "-m", "code");
	assert.deepEqual(await readCheckout(project.dir, true).then(({ checks, code }) => ({ checks, code })), { checks: 0, code: true });
	mkdirSync(join(project.dir, ".agents"));
	writeFileSync(join(project.dir, ".agents", "project.json"), JSON.stringify({ checks: [{ name: "tests", command: "pnpm test" }, "pnpm lint"] }));
	git(project.dir, "add", "-A");
	git(project.dir, "commit", "-q", "-m", "checks");
	assert.equal((await readCheckout(project.dir, true)).checks, 2);
	// A project inside a bigger repository reads its own folder.
	const { project: outer } = gitProject(root, "outer", { "package.json": "{}\n" });
	const inner = join(outer.dir, "inner");
	mkdirSync(inner);
	writeFileSync(join(inner, "notes.txt"), "x\n");
	git(outer.dir, "add", "-A");
	git(outer.dir, "commit", "-q", "-m", "inner");
	assert.equal((await readCheckout(inner, true)).code, false);
});

test("watchers hear the whole list when a checkout changes, and only then", async (t) => {
	const root = tempDir(t);
	const { project } = gitProject(root, "one");
	const watcher = watchCheckouts(() => [project], () => true, 50);
	t.after(() => watcher.close());
	assert.equal((await watcher.current()).get(project.dir)?.dirty, 0);
	const heard: number[] = [];
	const stop = watcher.onChange((found) => heard.push(found.get(project.dir)!.dirty));
	await new Promise((resolve) => setTimeout(resolve, 200));
	assert.deepEqual(heard, [], "nothing changed");
	writeFileSync(join(project.dir, "b.txt"), "x\n");
	await new Promise((resolve) => setTimeout(resolve, 250));
	assert.deepEqual(heard, [1]);
	stop();
});
