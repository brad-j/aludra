// After a sandbox session's run ends, its commits come home without anyone asking: fetched into `sandbox/N` in the
// project's checkout, and with `sandboxes.afterRun: "merge"` the checked-out branch fast-forwarded to them when that's
// safe (src/sandboxes.ts). One sync per session at a time; a run that ends while one is going waits for it and syncs
// again. Nothing here throws: a sync that fails is reported, and `aludra sync` can be run by hand.
import type { SessionSummary } from "./api-types.ts";
import type { Host } from "./host.ts";
import type { MergeResult, SyncResult } from "./sandboxes.ts";

/** What happened after a run, in a line, for the log and the run-end notification. */
export function describeSync(result: SyncResult & { merge?: MergeResult }): string {
	const fetched = result.commits === 0 ? "no new commits" : `${result.commits} commit${result.commits === 1 ? "" : "s"} on ${result.branch}`;
	const left = result.uncommitted > 0 ? `; ${result.uncommitted} uncommitted file${result.uncommitted === 1 ? "" : "s"} left in the sandbox` : "";
	if (result.merge === undefined || result.commits === 0) return `${fetched}${left}`;
	return result.merge.merged ? `${fetched}, fast-forwarded ${result.merge.onto}${left}` : `${fetched}, not merged: ${result.merge.reason}${left}`;
}

export function sandboxSyncAfterRuns(
	host: Pick<Host, "sessions" | "sandboxes">,
	mode: () => "off" | "fetch" | "merge" | undefined,
	report: (id: number, line: string) => void = (id, line) => console.error(`[sandbox] session ${id}: ${line}`),
) {
	const going = new Map<number, Promise<void>>();
	const again = new Set<number>();

	async function syncOnce(id: number) {
		const how = mode();
		if (how === undefined || how === "off") return;
		const record = await host.sessions.get(id);
		if (record?.sandbox === undefined || record.source === undefined) return;
		try {
			const result = await host.sandboxes.sync(id, undefined, { merge: how === "merge" });
			report(id, describeSync(result));
		} catch (error) {
			report(id, `sync failed: ${error instanceof Error ? error.message : String(error)}; run aludra sync --session ${id}`);
		}
	}

	function onRunEnd(summary: Pick<SessionSummary, "id" | "state">) {
		if (summary.state !== "done" && summary.state !== "failed") return;
		const id = summary.id;
		if (going.has(id)) {
			again.add(id);
			return;
		}
		const run = (async () => {
			do {
				again.delete(id);
				await syncOnce(id);
			} while (again.has(id));
		})().finally(() => going.delete(id));
		going.set(id, run);
	}

	return {
		onRunEnd,
		/** Resolves once the syncs going now are done; for shutdown and tests. */
		settled: () => Promise.all(going.values()).then(() => undefined),
		/** Resolves once session `id`'s sync, if one is going, is done; the run-end notification waits for it. */
		idle: (id: number) => going.get(id) ?? Promise.resolve(),
	};
}
