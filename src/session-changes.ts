// Session changes for agents that wake on them, such as Lan's gate over /mcp (src/mcp.ts check_sessions and
// mark_sessions_handled), in the pattern of a mail connector's check_new_mail and mark_handled(throughUid).
//
// session-changes.sqlite in the data directory keeps three things: what was last seen of each session (its state and
// when it was last updated), a journal of the changes worth waking for, numbered in order, and one cursor per MCP token,
// the last change that token has handled. `observe` compares the sessions as they are now with what was last seen and
// adds a change for each session that's new, or that has come to rest in done, failed, stopped, waiting or idle since:
// a new state, or the same one after a newer run. Running is noted without a change, so the next one reads running →
// done. Reading changes never moves a cursor; only `markHandled` does, and only the calling token's, so one agent
// handling a change doesn't hide it from another.
//
// The journal is filled when an agent checks, not as sessions change, so a run that starts and ends between two checks
// is one change (done → done, a newer `updated`). What was seen is kept across restarts, so changes made while no one
// checked, or while the host was down, are found at the next check. The file notes when it was made, and a session last
// updated before then is recorded without a change, so the sessions there before this existed don't all read as new.
// A token that has never marked anything gets the changes to sessions updated since the token was made.
import { DatabaseSync } from "node:sqlite";
import type { SessionState } from "./api-types.ts";

/** The states a session comes to rest in, which wake an agent. */
export const RESTING: readonly SessionState[] = ["done", "failed", "stopped", "waiting", "idle"];

export type Seen = { id: number; state: SessionState; updatedAt: number };
export type Change = { change: number; session: number; from: SessionState | null; to: SessionState; updatedAt: number; at: number };

/** How long a journal entry is kept; older ones are dropped when the file is opened. */
const KEEP_MS = 30 * 24 * 3600_000;

export function openSessionChanges(file: string) {
	const db = new DatabaseSync(file);
	db.exec(`
		PRAGMA journal_mode = WAL;
		PRAGMA busy_timeout = 5000;
		CREATE TABLE IF NOT EXISTS seen (session INTEGER PRIMARY KEY, state TEXT NOT NULL, updated_at INTEGER NOT NULL);
		CREATE TABLE IF NOT EXISTS changes (
			seq INTEGER PRIMARY KEY AUTOINCREMENT,
			session INTEGER NOT NULL,
			old TEXT,
			new TEXT NOT NULL,
			updated_at INTEGER NOT NULL,
			at INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS cursors (token INTEGER PRIMARY KEY, through INTEGER NOT NULL);
		CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
	`);
	db.prepare("DELETE FROM changes WHERE at < ?").run(Date.now() - KEEP_MS);
	const seenAll = db.prepare("SELECT session, state, updated_at FROM seen");
	const putSeen = db.prepare("INSERT INTO seen (session, state, updated_at) VALUES (?, ?, ?) ON CONFLICT (session) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at");
	const addChange = db.prepare("INSERT INTO changes (session, old, new, updated_at, at) VALUES (?, ?, ?, ?, ?)");
	const after = db.prepare("SELECT seq, session, old, new, updated_at, at FROM changes WHERE seq > ? ORDER BY seq");
	const since = db.prepare("SELECT seq, session, old, new, updated_at, at FROM changes WHERE updated_at >= ? ORDER BY seq");
	const head = db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM changes");
	const cursorOf = db.prepare("SELECT through FROM cursors WHERE token = ?");
	const putCursor = db.prepare("INSERT INTO cursors (token, through) VALUES (?, ?) ON CONFLICT (token) DO UPDATE SET through = MAX(through, excluded.through)");
	db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('since', ?)").run(String(Date.now()));
	const made = Number((db.prepare("SELECT value FROM meta WHERE key = 'since'").get() as { value: string }).value);

	type ChangeRow = { seq: number; session: number; old: SessionState | null; new: SessionState; updated_at: number; at: number };
	const changeOf = (row: ChangeRow): Change => ({ change: row.seq, session: row.session, from: row.old, to: row.new, updatedAt: row.updated_at, at: row.at });

	/** The last change token `token` has handled, or undefined when it has never marked one. */
	const cursor = (token: number): number | undefined => (cursorOf.get(token) as { through: number } | undefined)?.through;

	return {
		/** Notes `sessions` as they are now, adding a change for each that's new or has come to rest since it was last seen. */
		observe(sessions: readonly Seen[], now = Date.now()): void {
			// In one write transaction with the read, so two checks at once don't both add the same change.
			db.exec("BEGIN IMMEDIATE");
			try {
				const known = new Map((seenAll.all() as { session: number; state: SessionState; updated_at: number }[]).map((r) => [r.session, r]));
				for (const s of sessions) {
					const last = known.get(s.id);
					if (last !== undefined && last.state === s.state && last.updated_at === s.updatedAt) continue;
					// A summary read before the one already noted, from a slower caller, is older news.
					if (last !== undefined && s.updatedAt < last.updated_at) continue;
					putSeen.run(s.id, s.state, s.updatedAt);
					if (last === undefined && s.updatedAt < made) continue;
					if (last === undefined || RESTING.includes(s.state)) addChange.run(s.id, last?.state ?? null, s.state, s.updatedAt, now);
				}
				db.exec("COMMIT");
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		},
		/** The changes token `token` (made at `createdAt`) hasn't handled, oldest first. Moves nothing. */
		pending(token: number, createdAt: number): Change[] {
			const through = cursor(token);
			return ((through === undefined ? since.all(createdAt) : after.all(through)) as ChangeRow[]).map(changeOf);
		},
		/** Marks token `token`'s changes up to and including `through` handled; never moves back, nor past the newest. */
		markHandled(token: number, through: number): { through: number } {
			const newest = (head.get() as { seq: number }).seq;
			putCursor.run(token, Math.max(0, Math.min(through, newest)));
			return { through: cursor(token)! };
		},
		close: () => {
			if (db.isOpen) db.close();
		},
	};
}

export type SessionChanges = ReturnType<typeof openSessionChanges>;
