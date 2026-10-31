// Searching what was said in sessions: user messages and answers, not tool calls or their output.
//
// The index is its own SQLite file, search.sqlite in the data directory, with an FTS5 table (Node's built-in SQLite
// has it), so Pi Durable's database and schema are never touched and the index can be deleted and rebuilt at any time.
// It holds one row per message: the session, the Pi Durable entry, the message's index in it, who wrote it, when, and
// its text. The host fills it from committed entries as they land, and at start catches up from the newest entry it
// has, so entries committed while it was down are indexed too.
import { rmSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { Message } from "@earendil-works/pi-ai";
import { withoutVideoNotes } from "./videos.ts";

export type SearchHit = {
	session: number;
	/** The Pi Durable entry and message index; the transcript item's id is `e{entry}:{index}`. */
	entry: number;
	index: number;
	/** The transcript item's id, `e{entry}:{index}` (src/transcript.ts). */
	item: string;
	from: "user" | "agent";
	at: number;
	/** The text around the match, with matched words between « and ». */
	snippet: string;
};

/** What the index takes from an entry: its user messages and answers' text. */
export type IndexedMessage = { session: number; entry: number; index: number; from: "user" | "agent"; at: number; text: string };

/** The messages of an entry worth searching, from its kind and model messages. */
export function messagesOf(entry: { id: number; conversationId: number; kind: string; model?: readonly Message[] }): IndexedMessage[] {
	if (entry.kind !== "pi.user" && entry.kind !== "pi.assistant") return [];
	return (entry.model ?? []).flatMap((message, index): IndexedMessage[] => {
		if (message.role === "user" && entry.kind === "pi.user") {
			const text = typeof message.content === "string" ? message.content : message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
			const clean = withoutVideoNotes(text).replace(/<restored [^>]*>[\s\S]*?<\/restored>/g, "").trim();
			return clean === "" ? [] : [{ session: entry.conversationId, entry: entry.id, index, from: "user", at: message.timestamp, text: clean }];
		}
		if (message.role === "assistant") {
			const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
			return text === "" ? [] : [{ session: entry.conversationId, entry: entry.id, index, from: "agent", at: message.timestamp, text }];
		}
		return [];
	});
}

/**
 * A query as FTS5 understands it: each word a quoted term that must appear, the last also as a prefix, so search
 * works as you type. FTS5's own syntax (AND, NEAR, quotes, *) is never passed through, so no query is a syntax error.
 */
export function ftsQuery(query: string): string | undefined {
	const words = query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
	if (words.length === 0) return undefined;
	return words.map((word, i) => (i === words.length - 1 ? `"${word}"*` : `"${word}"`)).join(" ");
}

const SCHEMA_VERSION = 1;

export function openSearch(file: string) {
	let db = open();

	function open(): DatabaseSync {
		const opened = new DatabaseSync(file);
		const version = (opened.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
		if (version !== SCHEMA_VERSION) {
			// An index from another version is rebuilt: everything in it comes from Pi Durable's database.
			opened.close();
			for (const suffix of ["", "-wal", "-shm"]) rmSync(file + suffix, { force: true });
			const fresh = new DatabaseSync(file);
			fresh.exec(`
				PRAGMA journal_mode = WAL;
				CREATE VIRTUAL TABLE messages USING fts5(text, session UNINDEXED, entry UNINDEXED, idx UNINDEXED, author UNINDEXED, at UNINDEXED, tokenize = 'porter unicode61 remove_diacritics 2');
				CREATE TABLE indexed (entry INTEGER NOT NULL, idx INTEGER NOT NULL, PRIMARY KEY (entry, idx)) WITHOUT ROWID;
				CREATE TABLE progress (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), entry INTEGER NOT NULL);
				INSERT INTO progress VALUES (1, 0);
				PRAGMA user_version = ${SCHEMA_VERSION};
			`);
			return fresh;
		}
		return opened;
	}

	let statements = prepare();
	function prepare() {
		return {
			mark: db.prepare("INSERT OR IGNORE INTO indexed (entry, idx) VALUES (?, ?)"),
			insert: db.prepare("INSERT INTO messages (text, session, entry, idx, author, at) VALUES (?, ?, ?, ?, ?, ?)"),
			progress: db.prepare("SELECT entry FROM progress"),
			advance: db.prepare("UPDATE progress SET entry = max(entry, ?)"),
			search: db.prepare(`
				SELECT session, entry, idx, author, at, snippet(messages, 0, '«', '»', '…', 12) AS snippet
				FROM messages WHERE messages MATCH ? ORDER BY rank LIMIT ?`),
			searchIn: db.prepare(`
				SELECT session, entry, idx, author, at, snippet(messages, 0, '«', '»', '…', 12) AS snippet
				FROM messages WHERE messages MATCH ? AND session = ? ORDER BY rank LIMIT ?`),
		} satisfies Record<string, StatementSync>;
	}

	/** Adds messages not yet indexed; one already there is skipped. */
	function add(messages: readonly IndexedMessage[]) {
		db.exec("BEGIN");
		try {
			for (const m of messages) {
				if (statements.mark.run(m.entry, m.index).changes === 0) continue;
				statements.insert.run(m.text, m.session, m.entry, m.index, m.from, m.at);
			}
			db.exec("COMMIT");
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	}

	/**
	 * Notes every entry up to `entry` as looked at. Only a finished catch-up calls it: entry IDs are shared by all
	 * sessions, so a mark moved partway through, or by a live entry, could make the next start skip older entries.
	 */
	function advance(entry: number) {
		statements.advance.run(entry);
	}

	/** The newest entry ID looked at; catching up starts after it. */
	function progress(): number {
		return (statements.progress.get() as { entry: number }).entry;
	}

	/** The best matches for `query`, in one session if `session` is given; none for a query with no words. */
	function search(query: string, options: { session?: number; limit?: number } = {}): SearchHit[] {
		const match = ftsQuery(query);
		if (match === undefined) return [];
		const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
		const rows = (options.session === undefined ? statements.search.all(match, limit) : statements.searchIn.all(match, options.session, limit)) as {
			session: number;
			entry: number;
			idx: number;
			author: "user" | "agent";
			at: number;
			snippet: string;
		}[];
		return rows.map((r) => ({ session: r.session, entry: r.entry, index: r.idx, item: `e${r.entry}:${r.idx}`, from: r.author, at: r.at, snippet: r.snippet.replace(/\s+/g, " ").trim() }));
	}

	/** Empties the index, for a rebuild. */
	function reset() {
		db.close();
		for (const suffix of ["", "-wal", "-shm"]) rmSync(file + suffix, { force: true });
		db = open();
		statements = prepare();
	}

	return { add, advance, progress, search, reset, close: () => db.isOpen && db.close() };
}

export type SearchIndex = ReturnType<typeof openSearch>;
