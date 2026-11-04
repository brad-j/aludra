// A sandbox session's sandbox goes when the session is archived: its commits are fetched first (src/sandboxes.ts),
// then the sandbox is deleted on its host and the session marked, so a later message or `aludra sync` says so instead
// of failing on a sandbox that isn't there. A sandbox holding uncommitted files is kept, since deleting it would lose
// them; the session can be asked to commit, or unarchived and archived again. A session whose branch was discarded
// (sandbox.discard) isn't fetched again: its work was thrown away, so the sandbox goes as it is. Nothing here throws.
import type { Host, SessionRecord } from "./host.ts";
import type { SyncResult } from "./sandboxes.ts";

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
		sync = await host.sandboxes.sync(record.id);
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

/** Removes the sandbox of each session archived from now on; returns a stop function. */
export function removeSandboxesOnArchive(
	host: Pick<Host, "sandboxes" | "sessions">,
	log: (line: string) => void = console.error,
): { stop: () => void; settled: () => Promise<void> } {
	const going = new Set<Promise<void>>();
	const stop = host.sessions.onUpdate((record) => {
		if (record.archived !== true || record.sandbox === undefined || record.sandboxRemoved === true) return;
		const run = removeSandboxOf(host, record).then((outcome) => {
			log(outcome.removed
				? outcome.sync === undefined
					? `[sandbox] session ${record.id} archived: sandbox ${record.sandbox} deleted; its branch was discarded, so nothing was fetched`
					: `[sandbox] session ${record.id} archived: sandbox ${record.sandbox} deleted after fetching ${outcome.sync.commits} commit${outcome.sync.commits === 1 ? "" : "s"} to ${outcome.sync.branch}`
				: `[sandbox] session ${record.id} archived: sandbox ${record.sandbox} not deleted, ${outcome.reason}`);
		});
		going.add(run);
		void run.finally(() => going.delete(run));
	});
	return { stop, settled: () => Promise.all(going).then(() => undefined) };
}
