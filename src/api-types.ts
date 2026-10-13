// What the host's API sends and takes (src/api.ts), shared with the app (app/). Plain types only: the app imports this
// file, so it must not import anything that runs in Node.

export type SessionState = "running" | "waiting" | "failed" | "stopped" | "done" | "idle";

export type Thinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** One row in the sessions list. */
export type SessionSummary = {
	id: number;
	workspace: string;
	project: string;
	dir: string;
	title: string;
	createdAt: number;
	/** The last thing that happened, for ordering and the row's age. */
	updatedAt: number;
	state: SessionState;
	/** The latest activity, in a line: the running command, the answer's first line, or the failure. */
	line: string;
};

/** One thing in a session's transcript, in order. */
export type Item =
	| { kind: "user"; id: string; text: string; at: number }
	| { kind: "answer"; id: string; text: string; at: number; streaming?: boolean }
	| {
		kind: "call";
		id: string;
		tool: string;
		/** The call's arguments, long strings cut (see `cut`). */
		args: Record<string, unknown>;
		status: "pending" | "running" | "done" | "error";
		/** The result, or the running output; long output keeps its tail. */
		output?: string;
		/** How long it took, once done. */
		ms?: number;
	}
	| {
		kind: "failure";
		id: string;
		/** A safeguard refusal, a rate limit, a stop, or any other error from the model or the bridge. */
		type: "refused" | "rate-limit" | "stopped" | "error";
		message: string;
		requestId?: string;
		at: number;
	}
	| { kind: "compacted"; id: string; at: number };

/** Everything about a session except its transcript. */
export type SessionMeta = {
	summary: SessionSummary;
	model: { provider: string; id: string; name: string };
	thinking: Thinking;
	/** Tokens in the last request, and the model's window. */
	context: { used: number; window: number };
	/** Messages waiting for the run: steers go in at the next tool boundary, follow-ups when it answers. */
	queued: { id: number; mode: "steer" | "followUp"; text: string }[];
	approval?: { id: string; summary: string; command: string };
	/** A request failed and waits to retry. */
	retry?: { at: number; error: string };
};

export type ModelChoice = { provider: string; id: string; name: string };

/** One file a session changed, against the project as it was when the session started. */
export type ChangedFile = { path: string; old?: string; add: number; del: number; binary: boolean; status: "added" | "deleted" | "modified" | "renamed" };

/** A session's changes since it started, the biggest files first; unavailable outside git, or for older sessions. */
export type Changes = { available: true; since: number; add: number; del: number; files: ChangedFile[] } | { available: false; reason: string };

/** Something to do later, filed under its project. */
export type Idea = { id: number; workspace: string; project: string; dir: string; text: string; createdAt: number };

/** The devices that get notifications. */
export type PushState = { publicKey: string; devices: { endpoint: string; label: string; addedAt: number }[] };

export type Bootstrap = {
	user: string;
	machine: string;
	projects: { workspace: string; name: string; path: string; dir: string }[];
	models: ModelChoice[];
	thinking: Thinking[];
	defaults: { model: ModelChoice; thinking: Thinking };
};

/** Over the WebSocket, server to app. */
export type ServerEvent =
	| { type: "sessions"; sessions: SessionSummary[] }
	| { type: "ideas"; ideas: Idea[] }
	/** The transcript from `start` on; items before it are unchanged, and the transcript is `length` long. */
	| { type: "items"; session: number; start: number; items: Item[]; length: number }
	| { type: "meta"; session: number; meta: SessionMeta }
	| { type: "error"; message: string };

/**
 * Over the WebSocket, app to server: which session's transcript to follow, if any, and whether the app is on screen. A
 * session followed on screen doesn't get notifications: the user is looking at it.
 */
export type ClientEvent = { type: "follow"; session: number | null } | { type: "visible"; visible: boolean };
