import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { changesSince, fileDiff, parseNameStatus, parseNumstat, snapshot } from "../src/changes.ts";
import { tempDir } from "./helpers.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" });

/** A repository with a committed file, an uncommitted change and an ignored file, as the user might leave it. */
function repo(dir: string) {
	git(dir, "init", "-q", "-b", "main");
	writeFileSync(join(dir, ".gitignore"), "build/\n");
	writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\n");
	writeFileSync(join(dir, "old.txt"), "going away\n");
	writeFileSync(join(dir, "name.txt"), `${"stays the same, only the name changes\n".repeat(5)}`);
	git(dir, "add", "-A");
	git(dir, "commit", "-qm", "start");
	writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\nthe user's own edit\n");
}

test("the changes are what the session did: edits, new, deleted and renamed files, and its commits, not what was there before", async (t) => {
	const dir = tempDir(t);
	repo(dir);
	const indexBefore = readFileSync(join(dir, ".git", "index"));
	const base = await snapshot(dir);
	assert.ok(!("error" in base));
	assert.deepEqual(readFileSync(join(dir, ".git", "index")), indexBefore, "the real index is untouched");

	writeFileSync(join(dir, "a.txt"), "one\n2\nthree\nthe user's own edit\nfour\n");
	writeFileSync(join(dir, "new.ts"), "export const x = 1;\n");
	rmSync(join(dir, "old.txt"));
	git(dir, "mv", "name.txt", "renamed.txt");
	mkdirSync(join(dir, "build"));
	writeFileSync(join(dir, "build", "out.js"), "ignored");
	writeFileSync(join(dir, "committed.md"), "# committed\n");
	git(dir, "add", "committed.md");
	git(dir, "commit", "-qm", "by the session");

	const changes = await changesSince(base);
	assert.ok(changes.available);
	const byPath = Object.fromEntries(changes.files.map((f) => [f.path, f]));
	assert.deepEqual(Object.keys(byPath).sort(), ["a.txt", "committed.md", "new.ts", "old.txt", "renamed.txt"]);
	assert.deepEqual([byPath["a.txt"]!.add, byPath["a.txt"]!.del, byPath["a.txt"]!.status], [2, 1, "modified"]);
	assert.equal(byPath["new.ts"]!.status, "added");
	assert.equal(byPath["old.txt"]!.status, "deleted");
	assert.deepEqual([byPath["renamed.txt"]!.status, byPath["renamed.txt"]!.old], ["renamed", "name.txt"]);
	assert.equal(byPath["committed.md"]!.status, "added");
	assert.deepEqual([changes.add, changes.del], [4, 2]);

	const patch = await fileDiff(base, "a.txt");
	assert.match(patch, /^-two$/m);
	assert.match(patch, /^\+four$/m);
	assert.doesNotMatch(patch, /^\+the user's own edit$/m, "the edit from before the session isn't the session's");
	assert.equal(git(dir, "status", "--porcelain").includes("committed.md"), false, "nothing was staged for the user");
});

test("a project inside a bigger repository sees only its own directory, with paths relative to it", async (t) => {
	const root = tempDir(t);
	git(root, "init", "-q", "-b", "main");
	mkdirSync(join(root, "Projects", "one"), { recursive: true });
	mkdirSync(join(root, "Notes"));
	writeFileSync(join(root, "Projects", "one", "main.ts"), "a\n");
	git(root, "add", "-A");
	git(root, "commit", "-qm", "start");
	const project = join(root, "Projects", "one");
	const base = await snapshot(project);
	assert.ok(!("error" in base));
	writeFileSync(join(project, "main.ts"), "a\nb\n");
	writeFileSync(join(root, "Notes", "elsewhere.md"), "not this project\n");
	const changes = await changesSince(base);
	assert.ok(changes.available);
	assert.deepEqual(changes.files.map((f) => f.path), ["main.ts"]);
	assert.match(await fileDiff(base, "main.ts"), /^\+b$/m);
});

test("a project reached through a symlink has its changes", async (t) => {
	const root = tempDir(t);
	mkdirSync(join(root, "real"));
	repo(join(root, "real"));
	symlinkSync(join(root, "real"), join(root, "link"));
	const base = await snapshot(join(root, "link"));
	assert.ok(!("error" in base), "error" in base ? base.error : "");
	writeFileSync(join(root, "real", "new.ts"), "x\n");
	const changes = await changesSince(base);
	assert.ok(changes.available);
	assert.deepEqual(changes.files.map((f) => f.path), ["new.ts"]);
});

test("a directory outside git has no changes, and says why", async (t) => {
	const dir = tempDir(t);
	assert.deepEqual(await snapshot(dir), { error: "not a git repository" });
});

test("git's -z output is read, renames and binary files included", () => {
	assert.deepEqual(parseNumstat("3\t1\ta.txt\0-\t-\timg.png\0" + "0\t0\t\0old name.txt\0new name.txt\0"), [
		{ add: 3, del: 1, binary: false, path: "a.txt" },
		{ add: 0, del: 0, binary: true, path: "img.png" },
		{ add: 0, del: 0, binary: false, old: "old name.txt", path: "new name.txt" },
	]);
	assert.deepEqual([...parseNameStatus("M\0a.txt\0R096\0old.txt\0new.txt\0D\0gone\0")], [["a.txt", "M"], ["new.txt", "R096"], ["gone", "D"]]);
});
