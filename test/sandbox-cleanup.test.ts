import assert from "node:assert/strict";
import test from "node:test";
import type { SessionRecord } from "../src/host.ts";
import { removeSandboxesOnArchive, removeSandboxOf } from "../src/sandbox-cleanup.ts";
import type { SyncResult } from "../src/sandboxes.ts";

const record = (over: Partial<SessionRecord> = {}): SessionRecord => ({ id: 9, workspace: "w", project: "p", dir: "/home/user/work/p", title: "t", createdAt: 0, sandbox: 3, source: "/p", ...over });
const synced = (over: Partial<SyncResult> = {}): SyncResult => ({ sandbox: 3, dir: "/p", branch: "sandbox/3", head: "abc", commits: 1, uncommitted: 0, sandboxHead: "abc", ...over });

function fakeHost(options: { uncommitted?: number; state?: "running" | "idle"; syncFails?: boolean } = {}) {
	const calls: string[] = [];
	const listeners = new Set<(r: SessionRecord) => void>();
	const host = {
		sessions: {
			states: async () => new Map([[9, options.state ?? "idle"]]),
			onUpdate: (listener: (r: SessionRecord) => void) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		},
		sandboxes: {
			sync: async (id: number) => {
				calls.push(`sync ${id}`);
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

test("a session whose branch was discarded loses its sandbox without a fetch", async () => {
	const { host, calls } = fakeHost();
	const outcome = await removeSandboxOf(host, record({ archived: true, sandboxDiscarded: true }));
	assert.deepEqual(outcome, { removed: true });
	assert.deepEqual(calls, ["forget 9"]);
});
