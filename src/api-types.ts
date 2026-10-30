// What the host's API sends and takes (src/api.ts). Plain types only: a client can import this file, so it must not
// import anything that runs in Node.

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
	/** Dollars spent on providers that bill each request, if any of its answers came from one. */
	cost?: number;
	/** Hidden from the lists until brought back. */
	archived?: boolean;
};

/** One thing in a session's transcript, in order. */
/** Where an image is in a session; GET /api/sessions/:id/images/:entry/:message/:block has its bytes. */
export type ImageAt = { entry: number; message: number; block: number; mimeType: string };

export type Item =
	| { kind: "user"; id: string; text: string; at: number; images?: ImageAt[] }
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
		/** Images the result returned, such as a screenshot the call read. */
		images?: ImageAt[];
	}
	| {
		kind: "failure";
		id: string;
		/** A safeguard refusal, a rate limit, a stop, or any other error from the model or its provider. */
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

/** A model to pick. `price` is dollars per million input and output tokens, for providers that bill each request. */
export type ModelChoice = { provider: string; id: string; name: string; price?: { input: number; output: number } };

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
	/** The pinned models, from the settings. */
	models: ModelChoice[];
	/** Every model a session can run on, pinned or not, by provider. */
	catalog: ModelChoice[];
	thinking: Thinking[];
	defaults: { model: ModelChoice; thinking: Thinking };
};

/**
 * How a setting's value is shaped, for drawing its control: `text` and `path` are strings, `number` and `integer`
 * numbers, `list` a list of strings, `model` a model as `provider/id` (bootstrap's catalog lists them), `models` a list
 * of those, `choice` one of `options`, and `workspaces` a list of `{ name, roots }`.
 */
export type SettingKind = "text" | "path" | "number" | "integer" | "list" | "model" | "models" | "choice" | "workspaces";

export type SettingValue = string | number | string[] | { name: string; roots: string[] }[];

/** One setting, described well enough for any client to show and change it without knowing aludra's settings. */
export type Setting = {
	/** Its place in the settings file, such as `approvals.hosts`. */
	key: string;
	label: string;
	help: string;
	kind: SettingKind;
	/** What the settings file says, with defaults filled in. */
	value: SettingValue;
	/** What it is when the file doesn't say; absent for a setting with no default. */
	default?: SettingValue;
	/** Whether the file sets it, rather than leaving the default. */
	set: boolean;
	options?: string[];
	/** Whether the apps may change it. The rest change only in the file: a mistake there could lock every app out. */
	editable: boolean;
	/** Whether a change reaches the running host at once, rather than at its next restart. */
	live: boolean;
};

/** GET /api/settings and what a change answers with. */
export type Settings = {
	/** The settings file; null when the host started without one. */
	file: string | null;
	settings: Setting[];
	/** Keys whose saved value the running host doesn't have yet; a restart brings them in. */
	restart: string[];
	/** What's wrong in the file, if anything; the host wouldn't start with it like this. */
	errors: string[];
};

/** Over the WebSocket, server to app. */
export type ServerEvent =
	| { type: "sessions"; sessions: SessionSummary[] }
	/** The settings changed: the projects, models or defaults in the bootstrap may have too. */
	| { type: "settings" }
	| { type: "ideas"; ideas: Idea[] }
	/** Projects whose color was picked: name to hue index (src/project-colors.ts). */
	| { type: "colors"; colors: Record<string, number> }
	/** The transcript from `start` on; items before it are unchanged, and the transcript is `length` long. */
	| { type: "items"; session: number; start: number; items: Item[]; length: number }
	| { type: "meta"; session: number; meta: SessionMeta }
	| { type: "error"; message: string };

/**
 * Over the WebSocket, app to server: which session's transcript to follow, if any, and whether the app is on screen. A
 * session followed on screen doesn't get notifications: the user is looking at it.
 */
export type ClientEvent = { type: "follow"; session: number | null } | { type: "visible"; visible: boolean };
