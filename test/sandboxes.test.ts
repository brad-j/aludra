import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Connection, localDaemon } from "@earendil-works/pi-env";
import { context } from "../src/host.ts";
import { createSandboxes, templateName } from "../src/sandboxes.ts";
import { parseClientMessage } from "../src/server.ts";

test("a sandbox's connection opens on first use, stays open while a command runs, and closes once idle", async () => {
	const dir = mkdtempSync(join(tmpdir(), "aludra-sandboxes-"));
	const opened: number[] = [];
	// pi-env's daemon on this machine stands in for a sandbox: the same protocol, without SSH.
	const host = { ssh: "unused", gateKey: "/dev/null", hostKnownHosts: "/dev/null", sandboxKey: "/dev/null", sandboxHostKey: "ssh-ed25519 AAAA", dataDir: dir };
	const sandboxes = createSandboxes(host, {
		idleMs: 300,
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
