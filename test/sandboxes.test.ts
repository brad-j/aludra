import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { Connection, localDaemon } from "@earendil-works/pi-env";
import { context } from "../src/host.ts";
import { createSandboxes, fastForward, templateName } from "../src/sandboxes.ts";
import { sandboxSyncAfterRuns } from "../src/sandbox-sync.ts";
import { parseClientMessage } from "../src/server.ts";

test("a sandbox's connection opens on first use, stays open while a command runs, and closes once idle", async () => {
	const dir = mkdtempSync(join(tmpdir(), "aludra-sandboxes-"));
	const opened: number[] = [];
	// pi-env's daemon on this machine stands in for a sandbox: the same protocol, without SSH.
	const host = { ssh: "unused", gateKey: "/dev/null", hostKnownHosts: "/dev/null", sandboxKey: "/dev/null", sandboxHostKey: "ssh-ed25519 AAAA", dataDir: dir };
	const sandboxes = createSandboxes(host, {
		idleMs: 300,
		state: async () => "running",
		connect: (n) => {
			opened.push(n);
			return new Connection({ command: [localDaemon()] });
		},
	});
	try {
		assert.equal(sandboxes.connected(3), false);
		const env = sandboxes.env(3, dir);
		assert.equal(sandboxes.connected(3), true, "an environment holds a connection");

		// A command longer than the idle time keeps the connection open.
		let out = "";
		const result = await env.exec("sleep 0.6 && echo done", { onOutput: (t) => (out += t) }, context);
		assert.ok(result.ok && result.value.exitCode === 0);
		assert.equal(out.trim(), "done");
		assert.equal(sandboxes.connected(3), true, "still open right after the command");

		await new Promise((resolve) => setTimeout(resolve, 500));
		assert.equal(sandboxes.connected(3), false, "closed after the idle time with nothing in flight");

		// The next use opens a new connection.
		const again = sandboxes.env(3, dir);
		assert.ok((await again.writeFile("x.txt", "hello", context)).ok);
		assert.deepEqual(opened, [3, 3]);
	} finally {
		sandboxes.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("template names are safe for stedding and follow the commit", () => {
	assert.equal(templateName("raken", "0123456789abcdef0123"), "raken-0123456789ab");
	assert.equal(templateName("my project!", "abc"), "my-project--abc");
	assert.equal(templateName(".hidden", "abc"), "phidden-abc");
	assert.match(templateName("a b/c", "f00"), /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
});

test("without a sandbox host, sandboxes refuse to make one", async () => {
	const sandboxes = createSandboxes(undefined);
	assert.equal(sandboxes.configured(), false);
	await assert.rejects(sandboxes.create(), /no sandbox host/);
});

function git(dir: string, ...args: string[]): string {
	return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } }).trim();
}

test("sync fetches a sandbox's commits into a branch of the local checkout, leaving its branch and files alone", async () => {
	const root = mkdtempSync(join(tmpdir(), "aludra-sync-"));
	const local = join(root, "local");
	const remote = join(root, "sandbox");
	mkdirSync(local);
	git(local, "init", "-q", "-b", "main");
	writeFileSync(join(local, "a.txt"), "one\n");
	git(local, "add", "-A");
	git(local, "commit", "-q", "-m", "first");
	// The sandbox's copy: a clone with no remote, as a template has, and two commits of its own plus an uncommitted file.
	execFileSync("git", ["clone", "-q", local, remote]);
	git(remote, "remote", "remove", "origin");
	writeFileSync(join(remote, "a.txt"), "two\n");
	git(remote, "commit", "-q", "-am", "second");
	writeFileSync(join(remote, "b.txt"), "new\n");
	git(remote, "add", "b.txt");
	git(remote, "commit", "-q", "-m", "third");
	writeFileSync(join(remote, "c.txt"), "not committed\n");
	writeFileSync(join(local, "wip.txt"), "local work\n");

	const host = { ssh: "unused", gateKey: "/dev/null", hostKnownHosts: "/dev/null", sandboxKey: "/dev/null", sandboxHostKey: "ssh-ed25519 AAAA", dataDir: root };
	const sandboxes = createSandboxes(host, { connect: () => new Connection({ command: [localDaemon()] }) });
	try {
		const first = await sandboxes.sync(5, remote, local);
		assert.equal(first.branch, "sandbox/5");
		assert.equal(first.commits, 2);
		assert.equal(first.uncommitted, 1);
		assert.equal(git(local, "rev-parse", "sandbox/5"), git(remote, "rev-parse", "HEAD"));
		assert.equal(git(local, "symbolic-ref", "--short", "HEAD"), "main", "the checked-out branch stays");
		assert.equal(readFileSync(join(local, "a.txt"), "utf8"), "one\n", "the working tree stays");
		assert.ok(existsSync(join(local, "wip.txt")), "local uncommitted work stays");

		// Again with nothing new; then one more commit fast-forwards the branch.
		assert.equal((await sandboxes.sync(5, remote, local)).commits, 0);
		writeFileSync(join(remote, "c.txt"), "committed now\n");
		git(remote, "add", "c.txt");
		git(remote, "commit", "-q", "-m", "fourth");
		assert.equal((await sandboxes.sync(5, remote, local)).commits, 1);

		// History the sandbox rewrote isn't forced over the branch.
		git(remote, "reset", "-q", "--hard", "HEAD~2");
		git(remote, "commit", "-q", "--allow-empty", "-m", "rewritten");
		await assert.rejects(sandboxes.sync(5, remote, local), /rewrote history/);
		await assert.rejects(sandboxes.sync(5, remote, local, "main"), /checked out/);
		await assert.rejects(sandboxes.sync(5, remote, local, "../x"), /not a branch name/);
		assert.equal((await sandboxes.sync(5, remote, local, "sandbox/5-redo")).branch, "sandbox/5-redo");
	} finally {
		sandboxes.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("the socket's ask takes a sandbox flag only for a new session, and sync needs a session", () => {
	assert.deepEqual(parseClientMessage('{"type":"ask","content":"hi","project":"raken","sandbox":true}'), { type: "ask", content: "hi", project: "raken", sandbox: true });
	assert.throws(() => parseClientMessage('{"type":"ask","content":"hi","session":3,"sandbox":true}'), /new session/);
	assert.deepEqual(parseClientMessage('{"type":"sync","session":3,"into":"try"}'), { type: "sync", session: 3, into: "try" });
	assert.throws(() => parseClientMessage('{"type":"sync"}'), /needs a session/);
});

test("fastForward moves the checked-out branch only when nothing is lost and no uncommitted change is in the way", async () => {
	const root = mkdtempSync(join(tmpdir(), "aludra-ff-"));
	const repo = join(root, "repo");
	mkdirSync(repo);
	try {
		git(repo, "init", "-q", "-b", "main");
		writeFileSync(join(repo, "a.txt"), "one\n");
		writeFileSync(join(repo, "b.txt"), "one\n");
		git(repo, "add", "-A");
		git(repo, "commit", "-q", "-m", "first");
		git(repo, "branch", "sandbox/1");
		git(repo, "checkout", "-q", "sandbox/1");
		writeFileSync(join(repo, "a.txt"), "two\n");
		git(repo, "commit", "-q", "-am", "agent's change");
		git(repo, "checkout", "-q", "main");

		// An uncommitted change to a file the sandbox changed blocks it; one to another file doesn't.
		writeFileSync(join(repo, "a.txt"), "mine\n");
		const blocked = await fastForward(repo, "sandbox/1");
		assert.equal(blocked.merged, false);
		assert.match(blocked.merged ? "" : blocked.reason, /uncommitted changes to a\.txt/);
		assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "mine\n", "the change is still there");
		git(repo, "checkout", "-q", "--", "a.txt");
		writeFileSync(join(repo, "b.txt"), "mine\n");
		assert.deepEqual(await fastForward(repo, "sandbox/1"), { merged: true, onto: "main", commits: 1 });
		assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "two\n");
		assert.equal(readFileSync(join(repo, "b.txt"), "utf8"), "mine\n", "the unrelated change stays");
		assert.deepEqual(await fastForward(repo, "sandbox/1"), { merged: false, reason: "main already has it" });

		// A main that moved on isn't fast-forwarded: that's a real merge, left to the user.
		git(repo, "checkout", "-q", "sandbox/1");
		writeFileSync(join(repo, "c.txt"), "agent\n");
		git(repo, "add", "c.txt");
		git(repo, "commit", "-q", "-m", "agent again");
		git(repo, "checkout", "-q", "main");
		git(repo, "commit", "-q", "-am", "my own commit");
		const diverged = await fastForward(repo, "sandbox/1");
		assert.equal(diverged.merged, false);
		assert.match(diverged.merged ? "" : diverged.reason, /has commits sandbox\/1 doesn't/);
		assert.equal(git(repo, "log", "-1", "--format=%s"), "my own commit");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("after a sandbox run ends, its commits are synced once, again if it ends meanwhile, and never for other sessions", async () => {
	const calls: { id: number; merge?: boolean }[] = [];
	const records = new Map<number, { sandbox?: number; source?: string }>([[1, { sandbox: 4, source: "/p" }], [2, {}]]);
	let release: () => void = () => {};
	const host = {
		sessions: { get: async (id: number) => records.get(id) },
		sandboxes: {
			sync: async (id: number, _into: string | undefined, options: { merge?: boolean }) => {
				calls.push({ id, ...options });
				if (calls.length === 1) await new Promise<void>((resolve) => (release = resolve));
				return { sandbox: 4, dir: "/p", branch: "sandbox/4", head: "abc", commits: 2, uncommitted: 0, sandboxHead: "abc", ...(options.merge ? { merge: { merged: true as const, onto: "main", commits: 2 } } : {}) };
			},
		},
	};
	const lines: string[] = [];
	let mode: "off" | "fetch" | "merge" = "merge";
	// SAFETY: the sync only calls sessions.get and sandboxes.sync.
	const sync = sandboxSyncAfterRuns(host as never, () => mode, (id, line) => lines.push(`${id}: ${line}`));
	sync.onRunEnd({ id: 1, state: "done" });
	sync.onRunEnd({ id: 1, state: "done" });
	sync.onRunEnd({ id: 1, state: "running" });
	sync.onRunEnd({ id: 2, state: "done" });
	await new Promise((resolve) => setTimeout(resolve, 20));
	release();
	await sync.settled();
	assert.deepEqual(calls, [{ id: 1, merge: true }, { id: 1, merge: true }], "once, then once more for the run that ended meanwhile");
	assert.deepEqual(lines, ["1: 2 commits on sandbox/4, fast-forwarded main", "1: 2 commits on sandbox/4, fast-forwarded main"]);
	mode = "off";
	sync.onRunEnd({ id: 1, state: "done" });
	await sync.settled();
	assert.equal(calls.length, 2, "off syncs nothing");
});

test("sandbox sessions number their branches in one count across projects, past any branch an older session made", async (t) => {
	const { tempDir, gitProject, fakeSandboxes, testHost, SANDBOX_SETTINGS } = await import("./helpers.ts");
	const root = tempDir(t);
	const { project: one } = gitProject(root, "one");
	const { project: two } = gitProject(root, "two");
	const fake = fakeSandboxes(root);
	t.after(() => fake.close());
	fake.control.hold = true;
	const models = createModels();
	models.setProvider(fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] }).provider);
	const { host } = await testHost(t, { dir: root, sandboxes: fake.sandboxes, settings: SANDBOX_SETTINGS, models, model: { provider: "faux", modelId: "faux-1" } });
	const a = await host.sessions.startSandbox(one, "a");
	const b = await host.sessions.startSandbox(two, "b");
	const c = await host.sessions.startSandbox(one, "c");
	assert.deepEqual([a, b, c].map((r) => r.sandboxNumber), [0, 1, 2]);
	// A branch already in a checkout, from another data directory, is skipped.
	execFileSync("git", ["-C", two.dir, "branch", "sandbox/7"]);
	assert.equal((await host.sessions.startSandbox(two, "d")).sandboxNumber, 8);
	assert.ok([a, b, c].every((r) => r.sandboxState === "preparing" && r.sandbox === undefined));
	await assert.rejects(host.submit(a.id, "hi"), /still being made/);
	fake.control.hold = false;
	fake.control.release();
	await Promise.all([a, b, c].map((r) => host.sandboxes.prepared(r.id)));
	await Promise.all((await host.sessions.list()).map((r) => host.sandboxes.prepared(r.id)));
	// The sandbox host reuses its numbers once a sandbox is deleted; the branches never do.
	assert.equal((await host.sessions.get(c.id))?.sandboxState, "ready");
});

test("a sandbox that wakes runs the project's .agents/resume before the call that woke it, and a failing one doesn't stop the call", async () => {
	const dir = mkdtempSync(join(tmpdir(), "aludra-resume-"));
	const host = { ssh: "unused", gateKey: "/dev/null", hostKnownHosts: "/dev/null", sandboxKey: "/dev/null", sandboxHostKey: "ssh-ed25519 AAAA", dataDir: dir };
	let state = "running";
	const logged: string[] = [];
	const sandboxes = createSandboxes(host, { idleMs: 200, state: async () => state, log: (line) => logged.push(line), connect: () => new Connection({ command: [localDaemon()] }) });
	try {
		mkdirSync(join(dir, ".agents"));
		writeFileSync(join(dir, ".agents", "resume"), "#!/bin/sh\necho woke >> resumed.txt\n", { mode: 0o755 });
		const env = sandboxes.env(5, dir);
		// The first connection, to a running sandbox: nothing to resume.
		assert.ok((await env.exec("true", {}, context)).ok);
		assert.equal(existsSync(join(dir, "resumed.txt")), false);
		await new Promise((resolve) => setTimeout(resolve, 400));
		assert.equal(sandboxes.connected(5), false);

		// Paused meanwhile: the next call wakes it, and resume runs first, so the call sees what it did.
		state = "paused";
		let out = "";
		const woke = await sandboxes.env(5, dir).exec("cat resumed.txt", { onOutput: (t) => (out += t) }, context);
		assert.ok(woke.ok && woke.value.exitCode === 0);
		assert.equal(out.trim(), "woke");

		// A resume that fails is logged, and the call still runs.
		await new Promise((resolve) => setTimeout(resolve, 400));
		writeFileSync(join(dir, ".agents", "resume"), "#!/bin/sh\necho broken; exit 3\n", { mode: 0o755 });
		out = "";
		const after = await sandboxes.env(5, dir).exec("echo still", { onOutput: (t) => (out += t) }, context);
		assert.ok(after.ok && out.trim() === "still");
		assert.match(logged.join("\n"), /\.agents\/resume after waking exited 3: broken/);
	} finally {
		sandboxes.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
