import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { SessionRecord } from "../src/host.ts";
import { deleteLandedBranch, removeSandboxesOnArchive, removeSandboxOf } from "../src/sandbox-cleanup.ts";
import { tempDir } from "./helpers.ts";
import type { SyncResult } from "../src/sandboxes.ts";

const record = (over: Partial<SessionRecord> = {}): SessionRecord => ({ id: 9, workspace: "w", project: "p", dir: "/home/user/work/p", title: "t", createdAt: 0, sandbox: 3, source: "/p", ...over });
const synced = (over: Partial<SyncResult> = {}): SyncResult => ({ sandbox: 3, dir: "/p", branch: "sandbox/3", head: "abc", commits: 1, uncommitted: 0, sandboxHead: "abc", ...over });

function fakeHost(options: { uncommitted?: number; state?: "running" | "idle"; syncFails?: boolean } = {}) {
	const calls: string[] = [];
	const listeners = new Set<(r: SessionRecord) => void>();
	const host = {
		sessions: {
			states: async () => new Map([[9, options.state ?? "idle"]]),
			list: async () => [],
			get: async () => undefined,
			onUpdate: (listener: (r: SessionRecord) => void) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		},
		sandboxes: {
			sync: async (id: number, _into?: string, o: { force?: boolean } = {}) => {
				calls.push(`sync ${id}${o.force === true ? " force" : ""}`);
				if (options.syncFails) throw new Error("no route");
				return synced({ uncommitted: options.uncommitted ?? 0 });
			},
			forget: async (id: number) => void calls.push(`forget ${id}`),
		},
	};
	// SAFETY: the cleanup only calls the methods above.
	return { host: host as never, calls, update: (r: SessionRecord) => listeners.forEach((l) => l(r)) };
}

test("an archived session's sandbox is deleted after its commits are fetched", async () => {
	const { host, calls } = fakeHost();
	const outcome = await removeSandboxOf(host, record({ archived: true }));
	assert.equal(outcome.removed, true);
	assert.deepEqual(calls, ["sync 9", "forget 9"]);
});

test("a session that shipped is fetched with force, since the ship's rebase rewrote its branch, then deleted", async () => {
	for (const over of [{ shipped: { at: 1 } }, { shipStopped: { at: 1 } }] as unknown as Partial<SessionRecord>[]) {
		const { host, calls } = fakeHost();
		assert.equal((await removeSandboxOf(host, record({ archived: true, ...over }))).removed, true);
		assert.deepEqual(calls, ["sync 9 force", "forget 9"]);
	}
});

test("a sandbox is kept when it has uncommitted files, when the session is running, or when the fetch fails", async () => {
	for (const [options, reason] of [[{ uncommitted: 2 }, /2 uncommitted files/], [{ state: "running" as const }, /is running/], [{ syncFails: true }, /couldn't fetch.*no route/]] as const) {
		const { host, calls } = fakeHost(options);
		const outcome = await removeSandboxOf(host, record({ archived: true }));
		assert.equal(outcome.removed, false);
		assert.match(outcome.removed ? "" : outcome.reason, reason);
		assert.ok(!calls.includes("forget 9"), "never deleted");
	}
});

test("archiving triggers it; other updates, local sessions and removed sandboxes don't", async () => {
	const { host, calls, update } = fakeHost();
	const lines: string[] = [];
	const cleanup = removeSandboxesOnArchive(host, (line) => lines.push(line));
	update(record({ title: "renamed" }));
	update(record({ archived: true, sandbox: undefined }));
	update(record({ archived: true, sandboxRemoved: true }));
	update(record({ archived: true }));
	await cleanup.settled();
	cleanup.stop();
	assert.deepEqual(calls, ["sync 9", "forget 9"]);
	assert.match(lines.join("\n"), /session 9 archived: sandbox 3 deleted after fetching 1 commit to sandbox\/3/);
});

test("an archived sandbox session's branch goes once its head is on the upstream, never with a commit it lacks", async (t) => {
	const dir = tempDir(t);
	const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
	const remote = join(dir, "remote.git");
	const local = join(dir, "p");
	git(dir, "init", "-q", "--bare", "-b", "main", remote);
	git(dir, "init", "-q", "-b", "main", local);
	git(local, "commit", "-q", "--allow-empty", "-m", "first");
	git(local, "remote", "add", "origin", remote);
	git(local, "push", "-q", "-u", "origin", "main");
	const gone = (over: Partial<SessionRecord> = {}) => record({ archived: true, sandboxRemoved: true, sandboxNumber: 4, source: local, ...over });

	// Landed: sandbox/4 is a commit the upstream has.
	writeFileSync(join(local, "a.txt"), "a\n");
	git(local, "add", "a.txt");
	git(local, "commit", "-q", "-m", "work");
	git(local, "branch", "sandbox/4");
	git(local, "push", "-q", "origin", "main");
	assert.deepEqual(await deleteLandedBranch(gone()), { deleted: "sandbox/4" });
	assert.equal(git(local, "branch", "--list", "sandbox/4"), "");
	assert.deepEqual(await deleteLandedBranch(gone()), { kept: "no branch" });

	// Not landed: a commit only the branch has keeps it.
	git(local, "checkout", "-q", "-b", "sandbox/5");
	git(local, "commit", "-q", "--allow-empty", "-m", "unshipped");
	git(local, "checkout", "-q", "main");
	const kept = await deleteLandedBranch(gone({ sandboxNumber: 5 }));
	assert.match("kept" in kept ? kept.kept : "", /sandbox\/5 has commits origin\/main doesn't/);
	assert.notEqual(git(local, "branch", "--list", "sandbox/5"), "");

	// Not yet: not archived, its sandbox still there, or a scratch session.
	git(local, "branch", "sandbox/6", "main");
	for (const over of [{ archived: false }, { sandboxRemoved: false }, { scratch: true }] as Partial<SessionRecord>[]) {
		assert.ok("kept" in (await deleteLandedBranch(gone({ sandboxNumber: 6, ...over }))), JSON.stringify(over));
	}
	assert.notEqual(git(local, "branch", "--list", "sandbox/6"), "");
	// Checked out, it stays.
	git(local, "checkout", "-q", "sandbox/6");
	assert.ok("kept" in (await deleteLandedBranch(gone({ sandboxNumber: 6 }))));
});

test("a session whose branch was discarded loses its sandbox without a fetch", async () => {
	const { host, calls } = fakeHost();
	const outcome = await removeSandboxOf(host, record({ archived: true, sandboxDiscarded: true }));
	assert.deepEqual(outcome, { removed: true });
	assert.deepEqual(calls, ["forget 9"]);
});
