// Permissions: open inside a project, with a short list of exceptions.
//
// - The protected-path gate, ported from terminal pi (~/.pi/agent/extensions/protected-path-gate.ts): read, write and
//   edit of credential files, keys and agent logins are blocked, and so are shell commands naming them. The first
//   block in a run lets the run go on; a second ends it, so probing stays cut off. Ending a run takes a tool result
//   (`control.terminate`), which a beforeTool hook can't give, so the gate wraps the four tools instead.
// - Approvals, a beforeTool hook: `git push`, and ssh, scp, rsync, sftp, mosh or sshfs naming one of the homelab hosts
//   (egwene's keys reach them), wait for Brad. The request is stored, the call waits for a decision, and a restart
//   waits on the same request. Brad answers with `aludra approve` or `aludra deny`; push notifications come later.
//
// Both read shell commands as text, so they're best effort: a command can always be spelled so neither sees it.
import { randomBytes } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as background } from "@earendil-works/chord/context";
import type { ToolCall } from "@earendil-works/pi-ai";
import { type ConversationId, defineDoc, defineExtension, type Harness, type HookApi, hook, LiveDoc, type ToolRegistration, ToolTask, type Tx, wrapTool } from "@earendil-works/pi-durable";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import { classifyProtectedPath, matchProtectedCommand } from "./protected-paths.ts";

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "cancelled" | "superseded";

export type ApprovalRequest = {
	/** Short, for typing: `aludra approve 3f9a1c`. */
	id: string;
	conversationId: number;
	/** The tool call's task. A request whose task has ended isn't waited on any more. */
	taskId: number;
	/** What the call does, in a line. */
	summary: string;
	/** The whole command. */
	command: string;
	createdAt: number;
	expiresAt: number;
	status: ApprovalStatus;
	decidedAt?: number;
};

type ApprovalState = { requests: Record<string, ApprovalRequest> };

export const Approvals = defineDoc<ApprovalState>({
	kind: "aludra.approvals",
	version: 1,
	scope: "session",
	initial: () => ({ requests: {} }),
});

const WARNING = "Do not retry this target through another tool, path or command. Continue without it, or ask Brad.";
const SHELL_SEPARATORS = /;|&&|\|\||\||\n|\$\(|`|\(|\)/;
const REMOTE_COMMANDS = new Set(["ssh", "scp", "rsync", "sftp", "mosh", "sshfs"]);
/** Git's options that take the next word as their value. */
const GIT_OPTIONS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"]);
const KEEP_DECIDED_MS = 7 * 24 * 3_600_000;

/** The shell words of each simple command in `command`, quotes dropped. */
function commandWords(command: string): string[][] {
	return command
		.split(SHELL_SEPARATORS)
		.map((part) => part.trim().split(/\s+/).map((word) => word.replace(/["']/g, "")).filter((word) => word !== ""))
		.filter((words) => words.length > 0);
}

const programName = (word: string) => word.slice(word.lastIndexOf("/") + 1);

function isGitPush(words: readonly string[]): boolean {
	for (let i = 0; i < words.length; i++) {
		if (programName(words[i]!) !== "git") continue;
		let j = i + 1;
		while (j < words.length && words[j]!.startsWith("-")) j += GIT_OPTIONS_WITH_VALUE.has(words[j]!) ? 2 : 1;
		if (words[j] === "push") return true;
	}
	return false;
}

/** The homelab host a remote command in `words` names, if any: `host`, `user@host`, `host:path` or `host.domain`. */
function homelabHost(words: readonly string[], hosts: readonly string[]): string | undefined {
	const start = words.findIndex((word) => REMOTE_COMMANDS.has(programName(word)));
	if (start === -1) return undefined;
	for (const word of words.slice(start + 1)) {
		for (const part of word.split(/[@:]/)) {
			const host = hosts.find((h) => part === h || part.startsWith(`${h}.`));
			if (host !== undefined) return host;
		}
	}
	return undefined;
}

/** What a shell command does that needs Brad's approval, in a line, or nothing. */
export function approvalFor(command: string, hosts: readonly string[]): string | undefined {
	for (const words of commandWords(command)) {
		if (isGitPush(words)) return "git push";
		const host = homelabHost(words, hosts);
		if (host !== undefined) return `${programName(words.find((w) => REMOTE_COMMANDS.has(programName(w)))!)} to ${host}`;
	}
	return undefined;
}

/** Why the protected-path gate blocks a call of `tool` with `args` in `cwd`, or nothing. */
export function protectedTarget(tool: string, args: { readonly path?: unknown; readonly command?: unknown }, cwd: string): string | undefined {
	const { path, command } = args;
	if (tool === "read" || tool === "write" || tool === "edit") {
		if (typeof path !== "string" || path.trim() === "") return `${tool} target "(invalid path)" (rule: cannot inspect target)`;
		try {
			const kind = classifyProtectedPath(path, cwd);
			return kind === undefined ? undefined : `${tool} target ${JSON.stringify(path)} (rule: ${kind})`;
		} catch {
			return `${tool} target ${JSON.stringify(path)} (rule: cannot resolve target)`;
		}
	}
	if (tool === "bash") {
		if (typeof command !== "string") return `bash target "(invalid command)" (rule: cannot inspect command)`;
		const match = matchProtectedCommand(command, cwd);
		return match === undefined ? undefined : `bash target ${JSON.stringify(match.target)} (rule: ${match.kind})`;
	}
	return undefined;
}

/** A copy that outlives the commit. */
function plain(request: ApprovalRequest): ApprovalRequest {
	// SAFETY: a request is plain JSON data, so a JSON round trip gives back the same request.
	return JSON.parse(JSON.stringify(request)) as ApprovalRequest;
}

/** Requests and decisions, kept in a session document. Hooks can't write documents, so this does the writing. After gaidin's ApprovalService. */
export class ApprovalService {
	readonly #harness: Harness;
	readonly #waitMs: number;
	readonly #waiters = new Map<string, Set<(request: ApprovalRequest) => void>>();
	readonly #listeners = new Set<(request: ApprovalRequest) => void>();

	constructor(harness: Harness, waitMs: number) {
		this.#harness = harness;
		this.#waitMs = waitMs;
	}

	async #commit<T>(change: (doc: ApprovalState, tx: Tx) => T | Promise<T>): Promise<T> {
		const root = await this.#harness.root(background);
		return root.commit(async (tx) => change(await tx.doc(Approvals), tx), background);
	}

	async all(): Promise<ApprovalRequest[]> {
		const state = await this.#harness.snapshot(Approvals, background);
		return Object.values(state?.requests ?? {}).map(plain);
	}

	/** Requests still waiting for Brad, oldest first. Ones whose call ended or whose time ran out are closed. */
	async pending(): Promise<ApprovalRequest[]> {
		const waiting: ApprovalRequest[] = [];
		for (const request of await this.all()) {
			if (request.status !== "pending" || (await this.#reap(request))) continue;
			waiting.push(request);
		}
		return waiting.sort((a, b) => a.createdAt - b.createdAt);
	}

	async #reap(request: ApprovalRequest): Promise<boolean> {
		if (request.expiresAt <= Date.now()) {
			await this.close(request.id, "expired");
			return true;
		}
		// SAFETY: the task id is one Pi Durable gave out, stored as it was.
		const task = await this.#harness.getTask(request.taskId as Parameters<Harness["getTask"]>[0], background);
		if (task === undefined || task.state.status === "completing" || task.state.status === "terminal") {
			await this.close(request.id, "cancelled");
			return true;
		}
		return false;
	}

	/** Called with every new or settled request. */
	onChange(listener: (request: ApprovalRequest) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#emit(request: ApprovalRequest) {
		for (const listener of this.#listeners) listener(request);
	}

	/** Records a request under `key` unless one exists, and returns it as stored. */
	async open(key: string, at: { conversationId: number; taskId: number }, summary: string, command: string): Promise<ApprovalRequest> {
		const now = Date.now();
		const { request, created } = await this.#commit((doc) => {
			for (const [id, old] of Object.entries(doc.requests)) {
				if (old.status !== "pending" && (old.decidedAt ?? old.createdAt) < now - KEEP_DECIDED_MS) delete doc.requests[id];
			}
			const existing = doc.requests[key];
			if (existing !== undefined) return { request: plain(existing), created: false };
			const fresh: ApprovalRequest = { id: key, ...at, summary, command, createdAt: now, expiresAt: now + this.#waitMs, status: "pending" };
			doc.requests[key] = fresh;
			return { request: plain(fresh), created: true };
		});
		if (created) this.#emit(request);
		return request;
	}

	/** Brad's answer. Returns the request, or nothing if there's no pending one with that id. */
	async decide(id: string, allow: boolean): Promise<ApprovalRequest | undefined> {
		const decided = await this.#commit((doc) => {
			const request = doc.requests[id];
			if (request === undefined || request.status !== "pending") return undefined;
			request.status = request.expiresAt <= Date.now() ? "expired" : allow ? "approved" : "denied";
			request.decidedAt = Date.now();
			return plain(request);
		});
		if (decided !== undefined) this.#settled(decided);
		return decided;
	}

	/** Ends a pending request without an answer. */
	async close(id: string, status: "expired" | "cancelled" | "superseded"): Promise<void> {
		const closed = await this.#commit((doc) => {
			const request = doc.requests[id];
			if (request === undefined || request.status !== "pending") return undefined;
			request.status = status;
			request.decidedAt = Date.now();
			return plain(request);
		});
		if (closed !== undefined) this.#settled(closed);
	}

	/** Brad sent a session a new message instead of answering: its pending requests are closed, so the run can go on. */
	async supersede(conversationId: number): Promise<void> {
		for (const request of await this.pending()) {
			if (request.conversationId === conversationId) await this.close(request.id, "superseded");
		}
	}

	#settled(request: ApprovalRequest) {
		for (const resolve of this.#waiters.get(request.id) ?? []) resolve(request);
		this.#waiters.delete(request.id);
		this.#emit(request);
	}

	/** Resolves with the request once it's no longer pending; rejects when `signal` aborts. */
	async wait(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalRequest> {
		if (request.status !== "pending") return request;
		const settled = new Promise<ApprovalRequest>((resolve, reject) => {
			let waiters = this.#waiters.get(request.id);
			if (waiters === undefined) this.#waiters.set(request.id, (waiters = new Set()));
			const waiter = (done: ApprovalRequest) => {
				clearTimeout(timer);
				signal.removeEventListener("abort", onAbort);
				resolve(done);
			};
			waiters.add(waiter);
			const timer = setTimeout(() => void this.close(request.id, "expired").catch(() => {}), Math.max(0, request.expiresAt - Date.now()));
			timer.unref();
			// Stopping the run and closing the host both abort. Only a stopped call's task ends, so the request is closed
			// only then; after a restart the call runs again and waits on the same request.
			const onAbort = () => {
				clearTimeout(timer);
				waiters.delete(waiter);
				setTimeout(() => void this.#reap(request).catch(() => {}), 500).unref();
				reject(signal.reason ?? new Error("aborted"));
			};
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		});
		// A decision committed between reading the request and registering the waiter.
		const latest = (await this.all()).find((r) => r.id === request.id);
		if (latest !== undefined && latest.status !== "pending") this.#settled(latest);
		return settled;
	}
}

/**
 * Fires when the call is stopped and when the Harness closes. Pi Durable 1.1.0's tool runtime carries the second as
 * `signal`, which HookApi's type doesn't declare (as in gaidin).
 */
function signalOf(api: HookApi, context: Context): AbortSignal {
	const closed = "signal" in api && api.signal instanceof AbortSignal ? api.signal : undefined;
	return AbortSignal.any([context.abortSignal, closed].filter((signal) => signal !== undefined));
}

export type PermissionOptions = {
	/** Read lazily: the service needs the Harness, which is opened after the registry. */
	approvals: () => ApprovalService;
	hosts: readonly string[];
};

export function permissionsExtension(options: PermissionOptions) {
	/** Protected-path blocks per conversation, in its current run. */
	const blocks = new Map<ConversationId, { run: string | undefined; count: number }>();

	/** `tool`, refusing protected targets. */
	function gated(tool: ToolRegistration) {
		return wrapTool(tool, (inner) => ({
			...inner,
			execute: async (args, api, context) => {
				const cwd = (await api.agent(context)).cwd ?? process.cwd();
				// SAFETY: the Harness validated `args` against the tool's schema, an object, before calling it.
				const target = protectedTarget(inner.name, args as { path?: unknown; command?: unknown }, cwd);
				if (target === undefined) return inner.execute(args, api, context);
				// The run's inputs name it; its task changes with each generation.
				const run = (await api.snapshot(LiveDoc, api.conversationId, context))?.run?.inputs.join(",");
				const seen = blocks.get(api.conversationId);
				const count = seen !== undefined && seen.run === run ? seen.count + 1 : 1;
				blocks.set(api.conversationId, { run, count });
				const message = `Protected-path gate blocked ${target}`;
				if (count === 1) return { content: [{ type: "text", text: `${message}. ${WARNING}` }], isError: true };
				return { content: [{ type: "text", text: `${message}. Second block this run; stopping.` }], isError: true, control: { terminate: true } };
			},
		}));
	}

	async function approve(call: ToolCall, api: HookApi, context: Context) {
		const command = call.arguments.command;
		if (call.name !== "bash" || typeof command !== "string") return undefined;
		const summary = approvalFor(command, options.hosts);
		if (summary === undefined) return undefined;
		const approvals = options.approvals();
		// The same id for every run of this call's phase, so a restart doesn't ask twice.
		const id = await api.memo<string>("aludra.approval", randomBytes(3).toString("hex"), context);
		const request = await approvals.open(id, { conversationId: api.conversationId, taskId: api.taskId }, summary, command);
		const done = await approvals.wait(request, signalOf(api, context));
		if (done.status === "approved") return undefined;
		const why = done.status === "denied" ? "Brad said no"
			: done.status === "expired" ? "Brad didn't answer in time"
			: done.status === "superseded" ? "Brad sent a new message instead of answering"
			: "the run was stopped";
		return { block: `Needs Brad's approval (${summary}), and ${why}.` };
	}

	return defineExtension({
		name: "permissions",
		wraps: [createReadTool(), createWriteTool(), createEditTool(), createBashTool()].map(gated),
		hooks: [hook(ToolTask, { beforeTool: approve })],
	});
}
