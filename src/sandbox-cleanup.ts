// A sandbox session's sandbox goes when the session is archived: its commits are fetched first (src/sandboxes.ts),
// then the sandbox is deleted on its host and the session marked, so a later message or `aludra sync` says so instead
// of failing on a sandbox that isn't there. A sandbox holding uncommitted files is kept, since deleting it would lose
// them; the session can be asked to commit, or unarchived and archived again. A session whose branch was discarded
// (sandbox.discard) isn't fetched again: its work was thrown away, so the sandbox goes as it is. A session that shipped is
// fetched with force, as the ship itself does, since its rebase rewrote the commits its branch already has; without force
// the fetch is refused and the sandbox would stay forever. Nothing here throws.
//
// Once the sandbox is gone, its branch sandbox/N in the project's checkout goes too when its work has landed: the
// branch's head is reachable from the upstream the project ships to (shipBase), as the remote-tracking ref has it
// here. A landed ship leaves it so, since the ship force-fetches the rebased branch and pushes that head. A branch with
// a commit the upstream doesn't have is kept, and so is one checked out. Nothing is fetched for the check, so a branch
// landed by a push from elsewhere goes at the next sweep after a fetch. A sweep at start does the same for sessions
// archived before.
import { isSandboxSession, sandboxBranch, type Host, type SessionRecord } from "./host.ts";
import { deleteBranch, run, type SyncResult } from "./sandboxes.ts";
import { shipBase } from "./ship.ts";

export type CleanupOutcome =
	| { removed: true; sync?: SyncResult }
	| { removed: false; reason: string };

/** Fetches then deletes archived session `record`'s sandbox, unless it holds uncommitted files. */
export async function removeSandboxOf(host: Pick<Host, "sandboxes" | "sessions">, record: SessionRecord): Promise<CleanupOutcome> {
	if (record.sandbox === undefined || record.sandboxRemoved === true) return { removed: false, reason: "no sandbox" };
	// Archiving only hides a session, so one can be archived mid-run; its sandbox stays until it's idle and archived again.
	const state = (await host.sessions.states()).get(record.id);
	if (state === "running" || state === "waiting") return { removed: false, reason: `kept: the session is ${state}` };
	if (record.sandboxDiscarded === true) {
		try {
			await host.sandboxes.forget(record.id);
		} catch (error) {
			return { removed: false, reason: `couldn't delete it: ${error instanceof Error ? error.message : String(error)}` };
		}
		return { removed: true };
	}
	let sync: SyncResult;
	try {
		sync = await host.sandboxes.sync(record.id, undefined, { force: record.shipped !== undefined || record.shipStopped !== undefined });
	} catch (error) {
		return { removed: false, reason: `couldn't fetch its commits first: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (sync.uncommitted > 0) return { removed: false, reason: `kept: ${sync.uncommitted} uncommitted file${sync.uncommitted === 1 ? "" : "s"} in it` };
	try {
		await host.sandboxes.forget(record.id);
	} catch (error) {
		return { removed: false, reason: `couldn't delete it: ${error instanceof Error ? error.message : String(error)}` };
	}
	return { removed: true, sync };
}

/**
 * Deletes archived sandbox session `record`'s branch in its checkout when its work is on the upstream; returns the
 * branch deleted, or why it was kept. Only once the sandbox is gone, so no more commits can come home to it.
 */
export async function deleteLandedBranch(record: SessionRecord): Promise<{ deleted: string } | { kept: string }> {
	if (record.archived !== true || record.sandboxRemoved !== true || !isSandboxSession(record) || record.source === undefined || record.scratch === true) return { kept: "not an archived project sandbox session whose sandbox is gone" };
	const local = record.source;
	const branch = sandboxBranch(record);
	try {
		const head = (await run("git", ["-C", local, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).catch(() => "")).trim();
		if (head === "") return { kept: "no branch" };
		const base = await shipBase(local);
		const landed = await run("git", ["-C", local, "merge-base", "--is-ancestor", head, base.ref]).then(() => true, () => false);
		if (!landed) return { kept: `${branch} has commits ${base.ref.replace("refs/remotes/", "")} doesn't` };
		await deleteBranch(local, branch);
		return { deleted: branch };
	} catch (error) {
		return { kept: error instanceof Error ? error.message : String(error) };
	}
}

/** Removes the sandbox of each session archived from now on; returns a stop function. */
export function removeSandboxesOnArchive(
	host: Pick<Host, "sandboxes" | "sessions">,
	log: (line: string) => void = console.error,
): { stop: () => void; settled: () => Promise<void> } {
	const going = new Set<Promise<void>>();
	const stop = host.sessions.onUpdate((record) => {
		if (record.archived !== true || record.sandbox === undefined || record.sandboxRemoved === true) return;
		const task = removeSandboxOf(host, record).then(async (outcome) => {
			log(outcome.removed
				? outcome.sync === undefined
					? `[sandbox] session ${record.id} archived: sandbox ${record.sandbox} deleted; its branch was discarded, so nothing was fetched`
					: `[sandbox] session ${record.id} archived: sandbox ${record.sandbox} deleted after fetching ${outcome.sync.commits} commit${outcome.sync.commits === 1 ? "" : "s"} to ${outcome.sync.branch}`
				: `[sandbox] session ${record.id} archived: sandbox ${record.sandbox} not deleted, ${outcome.reason}`);
			if (!outcome.removed) return;
			const now = await host.sessions.get(record.id);
			if (now === undefined) return;
			const branch = await deleteLandedBranch(now);
			if ("deleted" in branch) log(`[sandbox] session ${record.id}: ${branch.deleted} deleted, its work is upstream`);
		});
		track(task);
	});
	const track = (task: Promise<void>) => {
		going.add(task);
		void task.finally(() => going.delete(task));
	};
	// Sessions archived before: their landed branches go now.
	track((async () => {
		const deleted: string[] = [];
		for (const record of await host.sessions.list()) {
			const outcome = await deleteLandedBranch(record);
			if ("deleted" in outcome) deleted.push(`${record.project} ${outcome.deleted}`);
		}
		if (deleted.length > 0) log(`[sandbox] deleted ${deleted.length} landed branch${deleted.length === 1 ? "" : "es"}: ${deleted.join(", ")}`);
	})().catch((error) => log(`[sandbox] sweeping landed branches: ${error instanceof Error ? error.message : String(error)}`)));
	return { stop, settled: () => Promise.all(going).then(() => undefined) };
}
