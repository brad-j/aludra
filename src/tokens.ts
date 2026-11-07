// Tokens for /mcp: one per agent that connects (Lan, Claude Code on a machine), sent as Authorization: Bearer. A token is
// shown once when it's made; only its SHA-256 is kept, in tokens.sqlite in the data directory, beside the database and
// the search index. Each has a scope: "read" gets the reading tools, "write" also the ones that start, message and
// stop sessions, and only while the settings file's mcp.write is on (src/mcp.ts). `aludra token add|list|revoke` makes
// and manages them, straight on the file, so the host needn't run; the host reads the file on every request, so a
// revoke holds at once.
//
// Why tokens and not the Tailscale login the API checks: tailscale serve sends no login for a tagged device, which is
// what a machine running agents unattended usually is, and a login names a person, not which of their agents called.
import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export type Scope = "read" | "write";
export type Token = { id: number; name: string; scope: Scope; createdAt: Date; lastSeenAt: Date | null; revokedAt: Date | null };

const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const date = (ms: number | null) => (ms === null ? null : new Date(ms));

type Row = { id: number; name: string; scope: Scope; created_at: number; last_seen_at: number | null; revoked_at: number | null };
const tokenOf = (row: Row): Token => ({ id: row.id, name: row.name, scope: row.scope, createdAt: new Date(row.created_at), lastSeenAt: date(row.last_seen_at), revokedAt: date(row.revoked_at) });

export function openTokens(file: string) {
	const db = new DatabaseSync(file);
	db.exec(`
		PRAGMA journal_mode = WAL;
		PRAGMA busy_timeout = 5000;
		CREATE TABLE IF NOT EXISTS tokens (
			id INTEGER PRIMARY KEY,
			name TEXT NOT NULL,
			scope TEXT NOT NULL CHECK (scope IN ('read', 'write')),
			hash TEXT NOT NULL UNIQUE,
			created_at INTEGER NOT NULL,
			last_seen_at INTEGER,
			revoked_at INTEGER
		);
	`);
	const insert = db.prepare("INSERT INTO tokens (name, scope, hash, created_at) VALUES (?, ?, ?, ?) RETURNING *");
	const seen = db.prepare("UPDATE tokens SET last_seen_at = ? WHERE hash = ? AND revoked_at IS NULL RETURNING *");
	const all = db.prepare("SELECT * FROM tokens ORDER BY id");
	const revoking = db.prepare("UPDATE tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL");

	return {
		/** Makes a token named `name`; the secret is returned this once. */
		create(name: string, scope: Scope, now = Date.now()): { token: Token; secret: string } {
			const secret = `aludra_${randomBytes(32).toString("base64url")}`;
			return { token: tokenOf(insert.get(name, scope, hash(secret), now) as Row), secret };
		},
		/** The live token `secret` is, its last use noted, or undefined. */
		authenticate(secret: string, now = Date.now()): Token | undefined {
			const row = seen.get(now, hash(secret)) as Row | undefined;
			return row === undefined ? undefined : tokenOf(row);
		},
		list: (): Token[] => (all.all() as Row[]).map(tokenOf),
		/** Whether a live token `id` was revoked. */
		revoke: (id: number, now = Date.now()): boolean => Number(revoking.run(now, id).changes) > 0,
		/** Closes the file; again is a no-op, as a host can be closed twice. */
		close: () => {
			if (db.isOpen) db.close();
		},
	};
}

export type Tokens = ReturnType<typeof openTokens>;

/** The secret in an Authorization: Bearer header, if there is one. */
export function bearerOf(header: string | undefined): string | undefined {
	return /^Bearer (\S+)$/i.exec(header ?? "")?.[1];
}
