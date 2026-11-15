// A worktree session's worktree goes when the session is archived, by hand or for being idle (src/archive.ts), as a
// sandbox does (src/sandbox-cleanup.ts): `git worktree remove` in its project, its worktree/N branch kept, so the
// commits stay for the user to merge. One that's running or waiting, or holds uncommitted files, is kept; archiving it
// again once it's at rest and committed removes it then. Worktrees of sessions archived before this ran stay until
// they're unarchived and archived again. Nothing here throws.
import type { Host, SessionRecord } from "./host.ts";
import { worktreeBranch } from "./host.ts";

/** Removes the worktree of each worktree session archived from now on. */
export function removeWorktreesOnArchive(
	host: Pick<Host, "sessions">,
	log: (line: string) => void = console.error,
): { stop: () => void; settled: () => Promise<void> } {
	const going = new Set<Promise<void>>();
	const stop = host.sessions.onUpdate((record: SessionRecord) => {
		if (record.archived !== true || record.worktree === undefined || record.worktreeRemoved === true) return;
		const run = host.sessions.removeWorktree(record.id).then((outcome) => {
			if (outcome.removed) log(`[worktree] session ${record.id} archived: its worktree was removed; its commits are on ${worktreeBranch(record)}`);
			else if (outcome.reason !== "already removed") log(`[worktree] session ${record.id} archived: its worktree wasn't removed, ${outcome.reason}`);
		});
		going.add(run);
		void run.finally(() => going.delete(run));
	});
	return { stop, settled: () => Promise.all(going).then(() => undefined) };
}
