import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Connection, localDaemon } from "@earendil-works/pi-env";
import { createSandboxes } from "../src/sandboxes.ts";
import { ship, shipPrompt, shipVerdict } from "../src/ship.ts";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: ENV }).trim();

test("the verdict is the last SHIP line of the answer", () => {
	assert.deepEqual(shipVerdict("Rebased and tested.\n\nSHIP-READY"), { ready: true });
	assert.deepEqual(shipVerdict("All good.\n`SHIP-READY`"), { ready: true });
	assert.deepEqual(shipVerdict("SHIP-READY\nThen a test broke.\nSHIP-BLOCKED: test/a.test.ts fails"), { ready: false, reason: "test/a.test.ts fails" });
	assert.deepEqual(shipVerdict("I rebased it."), { ready: false, reason: "the session didn't say SHIP-READY" });
	assert.match(shipPrompt("origin/main", "0123456789abcdef"), /refs\/aludra\/base[\s\S]*Don't push[\s\S]*SHIP-READY/);
});

/**
 * A remote (bare, standing in for GitHub), the local checkout cloned from it, and the sandbox: a clone of the local
 * checkout with no remote, as a template makes, reached through pi-env's local daemon. `agent` plays the session.
 */
function setup() {
	const root = mkdtempSync(join(tmpdir(), "aludra-ship-"));
	const remote = join(root, "remote.git");
	const local = join(root, "local");
	const box = join(root, "sandbox");
	execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
	mkdirSync(local);
	git(local, "init", "-q", "-b", "main");
	writeFileSync(join(local, "a.txt"), "one\n");
	git(local, "add", "-A");
	git(local, "commit", "-q", "-m", "first");
	git(local, "remote", "add", "origin", remote);
	git(local, "push", "-q", "-u", "origin", "main");
	execFileSync("git", ["clone", "-q", local, box]);
	git(box, "remote", "remove", "origin");
	const sandboxes = createSandboxes({ ssh: "unused", gateKey: "/dev/null", hostKnownHosts: "/dev/null", sandboxKey: "/dev/null", sandboxHostKey: "ssh-ed25519 AAAA", dataDir: root }, { connect: () => new Connection({ command: [localDaemon()] }) });
	const record = { id: 3, workspace: "w", project: "p", dir: box, title: "t", createdAt: 0, sandbox: 3, source: local };
	const host = {
		sessions: { get: async (id: number) => (id === 3 ? record : undefined) },
		sandboxes: {
			sync: (_id: number, into?: string, options: { force?: boolean } = {}) => sandboxes.sync(3, box, local, into, options),
			receiveBase: (_id: number, ref: string) => sandboxes.receiveBase(3, box, local, ref),
		},
	};
	return { root, remote, local, box, sandboxes, host: host as never, done: () => { sandboxes.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("ship rebases the sandbox's work onto a main that moved, then pushes it to main and fast-forwards here", async () => {
	const t = setup();
	try {
		// The agent's work in the sandbox, from the first commit.
		writeFileSync(join(t.box, "b.txt"), "agent\n");
		git(t.box, "add", "b.txt");
		git(t.box, "commit", "-q", "-m", "agent's work");
		// Meanwhile main moved on the remote, from another clone.
		const other = join(t.root, "other");
		execFileSync("git", ["clone", "-q", t.remote, other]);
		writeFileSync(join(other, "c.txt"), "someone\n");
		git(other, "add", "c.txt");
		git(other, "commit", "-q", "-m", "someone else's");
		git(other, "push", "-q", "origin", "main");

		const prompts: string[] = [];
		const result = await ship(t.host, 3, {
			ask: async (_id, prompt) => {
				prompts.push(prompt);
				// The session's part: rebase onto what the host put in, as the prompt says.
				git(t.box, "rebase", "-q", "refs/aludra/base");
				return { status: "done", answer: "Rebased onto origin/main; tests pass.\nSHIP-READY" };
			},
		});
		assert.equal(result.shipped, true, result.shipped ? "" : result.reason);
		assert.ok(result.shipped && result.mode === "main" && result.commits === 1);
		assert.match(prompts[0]!, /land on origin\/main/);
		assert.deepEqual(git(t.remote, "log", "--format=%s", "main").split("\n"), ["agent's work", "someone else's", "first"]);
		assert.equal(git(t.local, "rev-parse", "main"), git(t.remote, "rev-parse", "main"), "the local main is fast-forwarded");
		assert.equal(readFileSync(join(t.local, "c.txt"), "utf8"), "someone\n");
	} finally {
		t.done();
	}
});

test("nothing is pushed when the session is blocked, didn't rebase, or left files uncommitted", async () => {
	for (const [what, agent, reason] of [
		["blocked", async () => ({ status: "done", answer: "SHIP-BLOCKED: a test fails on main too" }), /a test fails on main too/],
		["no rebase", async () => ({ status: "done", answer: "SHIP-READY" }), /isn't on origin\/main/],
		["uncommitted", async (box: string) => { writeFileSync(join(box, "stray.txt"), "x\n"); return { status: "done", answer: "SHIP-READY" }; }, /uncommitted/],
	] as const) {
		const t = setup();
		try {
			writeFileSync(join(t.box, "b.txt"), "agent\n");
			git(t.box, "add", "b.txt");
			git(t.box, "commit", "-q", "-m", "agent's work");
			const other = join(t.root, "other");
			execFileSync("git", ["clone", "-q", t.remote, other]);
			git(other, "commit", "-q", "--allow-empty", "-m", "moved");
			git(other, "push", "-q", "origin", "main");
			const before = git(t.remote, "rev-parse", "main");
			const result = await ship(t.host, 3, { ask: async () => agent(t.box) });
			assert.equal(result.shipped, false, what);
			assert.match(result.shipped ? "" : result.reason, reason, what);
			assert.equal(git(t.remote, "rev-parse", "main"), before, `${what}: the remote is untouched`);
		} finally {
			t.done();
		}
	}
});
