// A checkout's uncommitted files, commits and one file's diff (src/project-status.ts), against real repositories, and
// over /app as projects.status and projects.diff.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { WebSocket } from "ws";
import { createApi } from "../src/api.ts";
import type { Json } from "../src/app/translate.ts";
import { MAX_FILES, parseStatusZ, projectDiff, projectStatus, StatusRefused } from "../src/project-status.ts";
import { tempDir, testHost } from "./helpers.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

/** A project with an upstream: two commits pushed, one more only here, and one only on the upstream. */
function repo(t: TestContext, dir = join(tempDir(t), "Projects", "Software", "demo")) {
	const remote = join(tempDir(t), "remote.git");
	git(tempDir(t), "init", "-q", "--bare", "-b", "main", remote);
	mkdirSync(dir, { recursive: true });
	git(dir, "init", "-q", "-b", "main");
	writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\n");
	writeFileSync(join(dir, "gone.txt"), "bye\n");
	writeFileSync(join(dir, "old-name.txt"), "renamed content that is long enough to be seen as a rename\n");
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", "first");
	git(dir, "remote", "add", "origin", remote);
	git(dir, "push", "-q", "-u", "origin", "main");
	// One commit on the upstream that isn't here.
	const other = join(tempDir(t), "other");
	git(tempDir(t), "clone", "-q", remote, other);
	git(other, "commit", "-q", "--allow-empty", "-m", "from elsewhere");
	git(other, "push", "-q");
	git(dir, "fetch", "-q");
	git(dir, "commit", "-q", "--allow-empty", "-m", "only here");
	return dir;
}

test("parseStatusZ reads porcelain v2: ordinary, renamed (with its old path), unmerged and untracked entries", () => {
	const text = ["# branch.oid abc", "# branch.head main", "# branch.upstream origin/main", "# branch.ab +2 -1", "1 .M N... 100644 100644 100644 a a a.txt", "1 A. N... 0 100644 100644 0 a new file.txt", "2 R. N... 100644 100644 100644 a a R100 new.txt", "old.txt", "u UU N... 100644 100644 100644 100644 a b c both.txt", "? note.md", ""].join("\0");
	const s = parseStatusZ(text);
	assert.deepEqual([s.branch, s.upstream, s.ahead, s.behind], ["main", "origin/main", 2, 1]);
	assert.deepEqual(s.files, [
		{ path: "a.txt", state: "modified", staged: false },
		{ path: "new file.txt", state: "added", staged: true },
		{ path: "new.txt", old: "old.txt", state: "renamed", staged: true },
		{ path: "both.txt", state: "conflicted", staged: false },
		{ path: "note.md", state: "untracked", staged: false },
	]);
});

test("projectStatus lists each uncommitted file with its state, staging and counts, and the commits ahead and behind", async (t) => {
	const dir = repo(t);
	writeFileSync(join(dir, "a.txt"), "one\nTWO\nthree\nfour\n");
	git(dir, "rm", "-q", "gone.txt");
	git(dir, "mv", "old-name.txt", "new-name.txt");
	writeFileSync(join(dir, "HANDOFF.md"), "line 1\nline 2\n");
	writeFileSync(join(dir, "blob.bin"), Buffer.from([0, 1, 2, 0]));
	const index = statSync(join(dir, ".git", "index")).mtimeMs;
	const status = await projectStatus(dir);
	assert.equal(statSync(join(dir, ".git", "index")).mtimeMs, index, "reading doesn't touch the index");
	assert.deepEqual([status.branch, status.upstream, status.ahead, status.behind], ["main", "origin/main", 1, 1]);
	const byPath = Object.fromEntries(status.files.map((f) => [f.path, f]));
	assert.deepEqual(byPath["a.txt"], { path: "a.txt", state: "modified", staged: false, add: 2, del: 1, binary: false });
	assert.deepEqual(byPath["gone.txt"], { path: "gone.txt", state: "deleted", staged: true, add: 0, del: 1, binary: false });
	assert.deepEqual(byPath["new-name.txt"], { path: "new-name.txt", old: "old-name.txt", state: "renamed", staged: true, add: 0, del: 0, binary: false });
	assert.deepEqual(byPath["HANDOFF.md"], { path: "HANDOFF.md", state: "untracked", staged: false, add: 2, del: 0, binary: false });
	assert.equal(byPath["blob.bin"]!.binary, true);
	assert.deepEqual(status.commits.ahead.map((c) => c.subject), ["only here"]);
	assert.deepEqual(status.commits.behind.map((c) => c.subject), ["from elsewhere"]);
	assert.match(status.commits.ahead[0]!.sha, /^[0-9a-f]{40}$/);
	assert.equal(status.truncated, undefined);
});

test("projectDiff gives one file's patch against HEAD, an untracked file as all added, and refuses unchanged or outside paths", async (t) => {
	const dir = repo(t);
	writeFileSync(join(dir, "a.txt"), "one\nTWO\nthree\n");
	git(dir, "add", "a.txt");
	writeFileSync(join(dir, "a.txt"), "one\nTWO\nthree\nfour\n");
	writeFileSync(join(dir, "HANDOFF.md"), "hello\n");
	writeFileSync(join(dir, "blob.bin"), Buffer.from([0, 1, 2, 0]));
	writeFileSync(join(dir, "huge.txt"), "x".repeat(500_000) + "\n");
	const modified = await projectDiff(dir, "a.txt");
	assert.ok("patch" in modified);
	assert.match(modified.patch, /^-two\n\+TWO\n three\n\+four$/m, "staged and unstaged together");
	const untracked = await projectDiff(dir, "HANDOFF.md");
	assert.ok("patch" in untracked);
	assert.match(untracked.patch, /new file mode[\s\S]*\+hello/);
	assert.deepEqual(await projectDiff(dir, "blob.bin"), { path: "blob.bin", binary: true });
	assert.deepEqual(await projectDiff(dir, "huge.txt"), { path: "huge.txt", tooLarge: true });
	await assert.rejects(projectDiff(dir, "gone.txt"), (e: unknown) => e instanceof StatusRefused && e.code === "not_found");
	for (const bad of ["../outside.txt", "/etc/passwd", "a/../../x"]) await assert.rejects(projectDiff(dir, bad), (e: unknown) => e instanceof StatusRefused && e.code === "bad_request", bad);
	assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "one\nTWO\nthree\nfour\n");
});

test("a project inside a bigger repository lists only its own files, by paths relative to it; many files are cut with truncated", async (t) => {
	const top = join(tempDir(t), "mono");
	mkdirSync(join(top, "apps", "web"), { recursive: true });
	git(top, "init", "-q", "-b", "main");
	writeFileSync(join(top, "root.txt"), "r\n");
	writeFileSync(join(top, "apps", "web", "w.txt"), "w\n");
	git(top, "add", "-A");
	git(top, "commit", "-q", "-m", "first");
	writeFileSync(join(top, "root.txt"), "changed\n");
	writeFileSync(join(top, "apps", "web", "w.txt"), "changed\n");
	const inner = await projectStatus(join(top, "apps", "web"));
	assert.deepEqual(inner.files.map((f) => f.path), ["w.txt"]);
	assert.equal(inner.upstream, undefined);
	assert.deepEqual(inner.commits, { ahead: [], behind: [] });
	assert.ok("patch" in (await projectDiff(join(top, "apps", "web"), "w.txt")));

	for (let i = 0; i <= MAX_FILES; i++) writeFileSync(join(top, `f${i}.txt`), "x\n");
	const many = await projectStatus(top);
	assert.equal(many.files.length, MAX_FILES);
	assert.equal(many.truncated, true);
	await assert.rejects(projectStatus(tempDir(t)), (e: unknown) => e instanceof StatusRefused && e.code === "bad_request");
});

test("projects.status and projects.diff over /app, by name or directory, with not_found and bad_request", async (t) => {
	const { host, dir } = await testHost(t);
	const project = repo(t, join(dir, "Projects", "Software", "demo"));
	writeFileSync(join(project, "HANDOFF.md"), "notes\n");
	const server = createApi(host, { users: ["you@example.com"], name: "test-host" });
	await new Promise<void>((resolve) => server.listen(0, resolve));
	t.after(() => server.close());
	const ws = new WebSocket(`ws://127.0.0.1:${(server.server.address() as AddressInfo).port}/app`, { headers: { "tailscale-user-login": "you@example.com" } });
	t.after(() => ws.close());
	const responses = new Map<string, Json>();
	ws.on("message", (data) => {
		const frame = JSON.parse(String(data));
		if (frame.type === "response") responses.set(frame.id, frame);
	});
	await new Promise((resolve) => ws.once("open", resolve));
	ws.send(JSON.stringify({ type: "hello", protocols: [1], client: { name: "test", version: "0" } }));
	let next = 0;
	const request = async (method: string, params: Json) => {
		const id = `r${++next}`;
		ws.send(JSON.stringify({ type: "request", id, method, params }));
		for (let i = 0; i < 300 && !responses.has(id); i++) await new Promise((resolve) => setTimeout(resolve, 20));
		const frame = responses.get(id)!;
		if (frame.error !== undefined) throw Object.assign(new Error(frame.error.message), { code: frame.error.code });
		return frame.result;
	};
	const byName = await request("projects.status", { project: "demo" });
	assert.deepEqual(byName.files.map((f: Json) => [f.path, f.state]), [["HANDOFF.md", "untracked"]]);
	assert.equal(byName.ahead, 1);
	assert.deepEqual((await request("projects.status", { project: project })).files.length, 1);
	const diff = await request("projects.diff", { project: "demo", path: "HANDOFF.md" });
	assert.equal(diff.path, "HANDOFF.md");
	assert.match(diff.patch, /\+notes/);
	await assert.rejects(request("projects.status", { project: "nope" }), { code: "not_found" });
	await assert.rejects(request("projects.diff", { project: "demo", path: "a.txt" }), { code: "not_found" });
	await assert.rejects(request("projects.diff", { project: "demo", path: "../x" }), { code: "bad_request" });
	await assert.rejects(request("projects.diff", { project: "demo" }), { code: "bad_request" });
});
