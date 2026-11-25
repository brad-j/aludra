// Requests to make a project, from an agent on /mcp (src/mcp.ts create_project and promote_session), which wait for the
// owner's approval before anything is made. An MCP call can't wait for a person: clients give up on a call after about
// a minute, and the endpoint is stateless. So a call stores a request here and answers that it's pending; the owner
// answers it as any approval, with `aludra approve ID` or `aludra deny ID`, or POST /api/approvals/:id, and a push
// notification says one waits. Approving makes the project then, on the host (src/host.ts decideProjectRequest), and
// keeps what came of it here; the agent calls the tool again with the same arguments to learn it.
//
// project-requests.sqlite in the data directory, beside tokens.sqlite: one row a request, with the token that asked,
// what it asked for (a new project, or a scratch sandbox session's work made one), its state, and the project's
// directory or the error once it's made or failed. A request waits `approvals.waitHours`, as other approvals do, and
// is expired when it's read after that. Nothing is made for a request that's denied or expires.
//
// A request is the same one when the same token asks for the same kind, name and session. Asking again while it waits,
// or after it's made, answers with it. Once a denial, an expiry or a failure has been told to the agent, asking again
// makes a new request, so the agent can try again without the owner having to clear anything.
//
// A create request may carry a starting plan (src/starters.ts PlanSeed), checked when it's asked for and written into
// the project's docs/plan.md once it's made, as projects.create's plan is. It's kept as JSON text in `plan`, a column
// added to older files when they're opened.
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { PlanSeed } from "./starters.ts";

export type ProjectRequestStatus = "pending" | "approved" | "denied" | "expired" | "done" | "failed";

export type ProjectRequest = {
	/** Short, as other approvals' are: `aludra approve 3f9a1c`. */
	id: string;
	/** The MCP token that asked. */
	token: number;
	/** `create`: a new project. `promote`: scratch sandbox session `session`'s work made project `name`. */
	kind: "create" | "promote";
	name: string;
	description?: string;
	/** A create request's starting plan, for the new project's docs/plan.md. */
	plan?: PlanSeed;
	session?: number;
	status: ProjectRequestStatus;
	createdAt: number;
	expiresAt: number;
	decidedAt?: number;
	/** The project's directory, once it's made. */
	dir?: string;
	/** Why making it failed, once it has. */
	error?: string;
	/** Whether a denial, expiry or failure has been answered to the agent. */
	reported: boolean;
};

/** A request's states that end it. */
const ENDED: readonly ProjectRequestStatus[] = ["denied", "expired", "failed"];
const KEEP_MS = 30 * 24 * 3_600_000;

type Row = { id: string; token: number; kind: "create" | "promote"; name: string; description: string | null; plan: string | null; session: number | null; status: ProjectRequestStatus; created_at: number; expires_at: number; decided_at: number | null; dir: string | null; error: string | null; reported: number };
const requestOf = (row: Row): ProjectRequest => ({
	id: row.id,
	token: row.token,
	kind: row.kind,
	name: row.name,
	...(row.description === null ? {} : { description: row.description }),
	...(row.plan === null ? {} : { plan: JSON.parse(row.plan) as PlanSeed }),
	...(row.session === null ? {} : { session: row.session }),
	status: row.status,
	createdAt: row.created_at,
	expiresAt: row.expires_at,
	...(row.decided_at === null ? {} : { decidedAt: row.decided_at }),
	...(row.dir === null ? {} : { dir: row.dir }),
	...(row.error === null ? {} : { error: row.error }),
	reported: row.reported === 1,
});

/** What a request is in a line, as `aludra approvals` lists it. */
export function describeProjectRequest(request: ProjectRequest): string {
	const what = request.kind === "create" ? `make project ${request.name}` : `make session ${request.session}'s work project ${request.name}`;
	return `${what}${request.description === undefined ? "" : `: ${request.description}`}${planNote(request.plan)}`;
}

/** " (plan: 3 steps, 1 question)" for a seed with items, else nothing. */
function planNote(plan: PlanSeed | undefined): string {
	const count = (n: number, one: string) => (n === 0 ? [] : [`${n} ${one}${n === 1 ? "" : "s"}`]);
	const parts = [...count(plan?.steps?.length ?? 0, "step"), ...count(plan?.questions?.length ?? 0, "question")];
	return parts.length === 0 ? "" : ` (plan: ${parts.join(", ")})`;
}

/** `waitMs` is read as each request is made: the setting can change while the host runs. */
export function openProjectRequests(file: string, waitMs: () => number) {
	const db = new DatabaseSync(file);
	db.exec(`
		PRAGMA journal_mode = WAL;
		PRAGMA busy_timeout = 5000;
		CREATE TABLE IF NOT EXISTS requests (
			id TEXT PRIMARY KEY,
			token INTEGER NOT NULL,
			kind TEXT NOT NULL CHECK (kind IN ('create', 'promote')),
			name TEXT NOT NULL,
			description TEXT,
			plan TEXT,
			session INTEGER,
			status TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			expires_at INTEGER NOT NULL,
			decided_at INTEGER,
			dir TEXT,
			error TEXT,
			reported INTEGER NOT NULL DEFAULT 0
		);
	`);
	// Files from before plans had no plan column.
	if (!(db.prepare("PRAGMA table_info(requests)").all() as { name: string }[]).some((c) => c.name === "plan")) db.exec("ALTER TABLE requests ADD COLUMN plan TEXT");
	db.prepare("DELETE FROM requests WHERE status != 'pending' AND COALESCE(decided_at, created_at) < ?").run(Date.now() - KEEP_MS);
	const insert = db.prepare("INSERT INTO requests (id, token, kind, name, description, plan, session, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?) RETURNING *");
	const byId = db.prepare("SELECT * FROM requests WHERE id = ?");
	const latest = db.prepare("SELECT * FROM requests WHERE token = ? AND kind = ? AND name = ? AND session IS ? ORDER BY created_at DESC, rowid DESC LIMIT 1");
	const waiting = db.prepare("SELECT * FROM requests WHERE status = 'pending' ORDER BY created_at");
	const expiring = db.prepare("UPDATE requests SET status = 'expired', decided_at = ? WHERE status = 'pending' AND expires_at <= ? RETURNING *");
	const deciding = db.prepare("UPDATE requests SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending' RETURNING *");
	const finishing = db.prepare("UPDATE requests SET status = ?, dir = ?, error = ? WHERE id = ? AND status = 'approved' RETURNING *");
	const reporting = db.prepare("UPDATE requests SET reported = 1 WHERE id = ?");
	const listeners = new Set<(request: ProjectRequest) => void>();
	const emit = (request: ProjectRequest) => {
		for (const listener of listeners) listener(request);
	};
	/** Expires the requests whose time ran out, and tells listeners. */
	const expire = (now = Date.now()) => {
		for (const row of expiring.all(now, now) as Row[]) emit(requestOf(row));
	};
	const get = (id: string): ProjectRequest | undefined => {
		expire();
		const row = byId.get(id) as Row | undefined;
		return row === undefined ? undefined : requestOf(row);
	};

	return {
		get,
		/** Requests waiting for the owner, oldest first. */
		pending(): ProjectRequest[] {
			expire();
			return (waiting.all() as Row[]).map(requestOf);
		},
		/** Token `token`'s latest request for `kind`, `name` and `session`, if any. */
		find(token: number, kind: "create" | "promote", name: string, session?: number): ProjectRequest | undefined {
			expire();
			const row = latest.get(token, kind, name, session ?? null) as Row | undefined;
			return row === undefined ? undefined : requestOf(row);
		},
		/** Whether `request` ended without a project, and the agent has been told so: asking again is a new request. */
		spent: (request: ProjectRequest) => ENDED.includes(request.status) && request.reported,
		/** Notes that the agent was told how `request` ended. */
		report(request: ProjectRequest): void {
			if (ENDED.includes(request.status)) reporting.run(request.id);
		},
		/** Stores a new pending request and tells listeners. `plan` is a create request's checked starting plan. */
		open(token: number, kind: "create" | "promote", name: string, description: string | undefined, session?: number, plan?: PlanSeed): ProjectRequest {
			const now = Date.now();
			let id = randomBytes(3).toString("hex");
			while (byId.get(id) !== undefined) id = randomBytes(3).toString("hex");
			const request = requestOf(insert.get(id, token, kind, name, description ?? null, plan === undefined ? null : JSON.stringify(plan), session ?? null, now, now + waitMs()) as Row);
			emit(request);
			return request;
		},
		/** The owner's answer: `approved` or `denied` (`expired` if its time ran out). Undefined unless it was pending. */
		decide(id: string, allow: boolean): ProjectRequest | undefined {
			expire();
			const row = deciding.get(allow ? "approved" : "denied", Date.now(), id) as Row | undefined;
			if (row === undefined) return undefined;
			const request = requestOf(row);
			emit(request);
			return request;
		},
		/** What came of an approved request: the project's directory, or why it couldn't be made. */
		finish(id: string, outcome: { dir: string } | { error: string }): ProjectRequest | undefined {
			const row = finishing.get("dir" in outcome ? "done" : "failed", "dir" in outcome ? outcome.dir : null, "error" in outcome ? outcome.error : null, id) as Row | undefined;
			if (row === undefined) return undefined;
			const request = requestOf(row);
			emit(request);
			return request;
		},
		/** Called with every new, decided, expired or finished request. */
		onChange(listener: (request: ProjectRequest) => void): () => void {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		/** Closes the file; again is a no-op, as a host can be closed twice. */
		close: () => {
			if (db.isOpen) db.close();
		},
	};
}

export type ProjectRequests = ReturnType<typeof openProjectRequests>;
