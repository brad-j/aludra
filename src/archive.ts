// Archiving sessions nobody has touched in a while, so the lists stay about current work. The host does it, rather than
// a client, so it happens while every client is closed and every client agrees on what's kept.
//
// A session goes when it has been idle `archive.afterDays` (default 3): nothing running, nothing waiting for approval,
// and no activity since. One brought back from the archive by hand is marked `kept` (host.sessions.archive) and stays
// until someone archives it again. Archiving only hides a session; its transcript and project are untouched, and any
// client brings it back.
import type { SessionSummary } from "./api-types.ts";
import type { Host } from "./host.ts";
import { readSummary } from "./live.ts";

const DAY = 86_400_000;

/** The sessions to archive among `sessions`: idle for `days`, not archived, not kept, nothing waiting. */
export function idleSessions(sessions: readonly (SessionSummary & { kept?: boolean })[], days: number, now = Date.now()): number[] {
	if (!(days > 0)) return [];
	const cutoff = now - days * DAY;
	return sessions
		.filter((s) => s.archived !== true && s.kept !== true && s.state !== "running" && s.state !== "waiting" && s.updatedAt <= cutoff)
		.map((s) => s.id)
		.sort((a, b) => a - b);
}

/** Archives `host`'s idle sessions once; returns the ones it archived. */
export async function archiveIdle(host: Host, now = Date.now()): Promise<number[]> {
	const days = host.archiveAfterDays();
	if (!(days > 0)) return [];
	const records = (await host.sessions.list()).filter((r) => r.archived !== true && r.kept !== true);
	const summaries = (await Promise.all(records.map(async (r) => {
		const summary = await readSummary(host, r.id);
		return summary === undefined ? undefined : { ...summary, ...(r.kept === true ? { kept: true } : {}) };
	}))).filter((s) => s !== undefined);
	const done: number[] = [];
	for (const id of idleSessions(summaries, days, now)) if (await host.sessions.archiveIdle(id)) done.push(id);
	return done;
}

/** Archives idle sessions a minute after start and every hour after; returns a stop function. */
export function scheduleArchive(host: Host, log: (line: string) => void = console.error): () => void {
	let running = false;
	const check = async () => {
		if (running) return;
		running = true;
		try {
			const done = await archiveIdle(host);
			if (done.length > 0) log(`[archive] archived ${done.length} idle session${done.length === 1 ? "" : "s"}: ${done.join(", ")}`);
		} catch (error) {
			log(`[archive] failed: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			running = false;
		}
	};
	const first = setTimeout(() => void check(), 60_000);
	const hourly = setInterval(() => void check(), 3_600_000);
	first.unref();
	hourly.unref();
	return () => {
		clearTimeout(first);
		clearInterval(hourly);
	};
}
