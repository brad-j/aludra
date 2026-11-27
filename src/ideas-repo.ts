// The ideas repository: the user's ideas as Markdown in a Git clone, named by `ideas.dir` in the settings, read and
// written only through this module (docs/using.md, "Ideas"). Brought over from Pi Desktop's pi-host, whose clones of
// the same repository on other machines sync through the same remote.
//
// Local first: a write takes the clone's lock, refuses unless the clone is clean, applies
// the change, regenerates INDEX.md from the files and commits, without touching the network.
// A change that fails before its commit puts the clone back where it started. Syncing runs
// after, in the background (`sync`): fetch, rebase local commits onto the upstream, push,
// retried with backoff while commits wait. A conflict in INDEX.md is settled by generating
// it again; any other conflict stops syncing and is never resolved here. Reads use the clone
// as it is and start a sync when the last one is older than a minute.

import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
/** A write's diff in its tool result is cut at this many characters. */
export const IDEA_DIFF_MAX = 12_000;

/**
 * Whether the clone can be used. `ok`: a clean checkout with an origin. `dirty` can be read but not written. `detail`
 * says what to do otherwise.
 */
export type IdeasStatus = {
	dir: string;
	state: "ok" | "missing" | "not_repo" | "no_remote" | "dirty";
	branch?: string;
	remote?: string;
	detail?: string;
	/** Background syncing with the remote, when the clone is usable. */
	sync?: IdeasSync;
};

/**
 * Writes commit to the clone at once; a sync fetches, rebases and pushes after. `pending`: local commits not pushed yet.
 * `error`: the last sync failed and is retried at `retryAt` while commits wait. `conflict`: changes from two machines
 * touch the same lines, or the clone needs a hand, and syncing waits for a person; `error` says what to do.
 */
export type IdeasSync = {
	state: "idle" | "syncing" | "error" | "conflict";
	pending: number;
	/** ms since the epoch. */
	lastSynced?: number;
	retryAt?: number;
	error?: string;
	/** Something a sync noticed that only a person can fix, such as one number given out on two machines. */
	warning?: string;
};
/** A read starts a sync when the last one began longer ago than this. */
const SYNC_AFTER_MS = 60_000;
const GIT_TIMEOUT_MS = 30_000;
/** Waits before each automatic retry while local commits are unsynced; the last one repeats. */
const RETRY_MS = [15_000, 30_000, 60_000, 120_000, 300_000];

export const STATUSES = ["raw", "exploring", "parked", "doing", "dropped"] as const;
export type IdeaStatus = (typeof STATUSES)[number];

/** One file in ideas/, from its frontmatter. */
export interface IdeaFile {
	id: number;
	title: string;
	status: string;
	areas: string[];
	created?: string;
	updated?: string;
	project?: string;
	summary?: string;
	/** Pi Desktop conversation ids about this idea (`chats: [12, 40]`), from before aludra held ideas. */
	chats: number[];
	/** aludra sessions about this idea, each `<host>/<session>` (`sessions: [egwene/12]`). */
	sessions: string[];
	/** Relative to the repository, e.g. ideas/2026-10-16-widget-factory.md. */
	path: string;
	/** Every frontmatter field as written, for fields this module doesn't name. */
	fields: Record<string, string>;
	body: string;
}

/** One line in inbox.md. */
export interface Capture {
	id: number;
	date: string;
	text: string;
}

export interface IdeasSnapshot {
	ideas: IdeaFile[];
	captures: Capture[];
	nextId: number;
}

/** Why a write or read didn't happen: the clone isn't usable, or Git refused. The message says what to do. */
export class IdeasError extends Error {
	readonly code: "missing" | "not_repo" | "dirty" | "conflict" | "git";
	constructor(code: "missing" | "not_repo" | "dirty" | "conflict" | "git", message: string) {
		super(message);
		this.code = code;
	}
}

type Git = (args: string[], cwd: string) => Promise<string>;

const realGit: Git = (args, cwd) =>
	new Promise((resolve, reject) => {
		execFile("git", args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (error, stdout, stderr) => {
			if (error && (error as { killed?: boolean }).killed) {
				// A timeout leaves no stderr. From a GUI launch it's usually SSH waiting on a key approval or passphrase.
				reject(new Error(`git ${args[0]} timed out after ${GIT_TIMEOUT_MS / 1000} s; it may be waiting on SSH (a key approval or passphrase)`));
			} else if (error) reject(new Error(`git ${args[0]}: ${stderr.trim() || error.message}`));
			else resolve(stdout);
		});
	});

export class IdeasRepo {
	/** When the last sync ended; a read starts one when it's over a minute ago and no retry is waiting. */
	private lastSyncEnd = 0;
	private syncState: Omit<IdeasSync, "pending"> = { state: "idle" };
	private syncRunning: Promise<void> | undefined;
	private syncQueued: Promise<void> | undefined;
	private retryTimer: ReturnType<typeof setTimeout> | undefined;
	private failures = 0;
	private closed = false;
	private listeners = new Set<() => void>();
	/** The HEAD a read or write last saw; a change means the repository changed. */
	private lastHead: string | undefined;
	private queue: Promise<unknown> = Promise.resolve();
	private readonly git: Git;

	readonly dir: string;

	constructor(dir: string, options: { git?: Git; now?: () => number; retryMs?: readonly number[] } = {}) {
		this.dir = dir;
		this.git = options.git ?? realGit;
		this.now = options.now ?? Date.now;
		this.retryMs = options.retryMs ?? RETRY_MS;
	}
	private readonly now: () => number;
	private readonly retryMs: readonly number[];

	/** Stop retrying; a sync already running finishes. */
	close(): void {
		this.closed = true;
		clearTimeout(this.retryTimer);
		this.retryTimer = undefined;
	}

	/** Called after a write, an undo, a sync that brought something new, or a change in sync state. */
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private async noteHead() {
		const head = (await this.git(["rev-parse", "HEAD"], this.dir).catch(() => "")).trim();
		const changed = this.lastHead !== undefined && head !== this.lastHead;
		this.lastHead = head;
		if (changed) for (const l of this.listeners) l();
	}

	/** Whether the clone is there and usable, for Settings. Doesn't pull. */
	async status(): Promise<IdeasStatus> {
		const dir = this.dir;
		if (!existsSync(dir)) return { dir, state: "missing", detail: `Clone the ideas repository to ${dir}, or point ideas.dir in the settings at a clone.` };
		const top = await this.git(["rev-parse", "--show-toplevel"], dir).catch(() => undefined);
		if (top === undefined || !sameDir(top.trim(), dir)) return { dir, state: "not_repo", detail: `${dir} isn't the top of a Git checkout.` };
		const branch = (await this.git(["branch", "--show-current"], dir).catch(() => "")).trim() || undefined;
		const remote = (await this.git(["remote", "get-url", "origin"], dir).catch(() => "")).trim() || undefined;
		if (!remote) return { dir, state: "no_remote", branch, detail: "It has no origin remote, so changes can't sync." };
		const dirty = (await this.git(["status", "--porcelain"], dir)).trim();
		const sync = { ...this.syncState, pending: await this.pending() };
		if (dirty) return { dir, state: "dirty", branch, remote, sync, detail: `Uncommitted changes in ${dir}. Commit or discard them before aludra writes here.` };
		return { dir, state: "ok", branch, remote, sync };
	}

	/** Every idea and capture in the clone as it is. Starts a sync when the last one is over a minute old. */
	async read(): Promise<IdeasSnapshot> {
		const snapshot = await this.serial(async () => {
			await this.usable();
			await this.noteHead();
			return readSnapshot(this.dir);
		});
		const waiting = this.retryTimer !== undefined || this.syncState.state === "conflict";
		if (!this.syncRunning && !waiting && this.now() - this.lastSyncEnd > SYNC_AFTER_MS) void this.sync();
		return snapshot;
	}

	/**
	 * One change, one commit, in the clone; syncing follows in the background. `change` edits files in the clone and
	 * gets the snapshot, so IDs it assigns follow the last sync. Returns the commit and what `change` returned.
	 * `message` can be built from that result, since IDs are assigned inside `change`.
	 */
	async write<T>(message: string | ((result: T) => string), change: (dir: string, snapshot: IdeasSnapshot) => Promise<T>): Promise<{ commit: string; result: T }> {
		const done = await this.serial(async () => {
			await this.usable();
			await this.requireClean();
			const start = (await this.git(["rev-parse", "HEAD"], this.dir)).trim();
			try {
				const result = await change(this.dir, await readSnapshot(this.dir));
				await writeFile(join(this.dir, "INDEX.md"), await renderIndex(this.dir));
				await this.git(["add", "-A"], this.dir);
				const staged = (await this.git(["diff", "--cached", "--name-only"], this.dir)).trim();
				if (!staged) return { commit: start, result };
				await this.git(["commit", "-q", "-m", typeof message === "string" ? message : message(result)], this.dir);
				const commit = (await this.git(["rev-parse", "HEAD"], this.dir)).trim();
				await this.noteHead();
				return { commit, result };
			} catch (error) {
				await this.restore(start);
				throw error;
			}
		});
		void this.sync();
		return done;
	}

	/** `commit`'s diff, INDEX.md left out, cut at IDEA_DIFF_MAX characters. */
	async diffOf(commit: string): Promise<{ diff: string; truncated: boolean }> {
		const diff = await this.git(["show", "--format=", "--no-color", "--no-ext-diff", commit, "--", ".", ":(exclude)INDEX.md"], this.dir);
		return diff.length > IDEA_DIFF_MAX ? { diff: diff.slice(0, IDEA_DIFF_MAX), truncated: true } : { diff, truncated: false };
	}

	/** Which of `commits` a later commit reverted ("This reverts commit <sha>"). */
	async reverted(commits: readonly string[]): Promise<string[]> {
		if (commits.length === 0) return [];
		const log = await this.git(["log", "--format=%B", "--grep=This reverts commit"], this.dir).catch(() => "");
		const done = new Set([...log.matchAll(/This reverts commit ([0-9a-f]{40})/g)].map((m) => m[1]!));
		const moved = await this.rewritten();
		return commits.filter((c) => done.has(c) || done.has(current(moved, c)));
	}

	/**
	 * Reverts `commit` with a new commit; syncing follows. INDEX.md is regenerated with the next ID kept where it was,
	 * so an undone capture's ID stays retired rather than being given out again.
	 */
	async undo(commit: string): Promise<{ commit: string }> {
		if (!/^[0-9a-f]{40}$/.test(commit)) throw new IdeasError("git", "That isn't a commit id.");
		const done = await this.serial(async () => {
			await this.usable();
			await this.requireClean();
			// A sync that rebased this commit gave it a new id; the chat still holds the old one.
			commit = current(await this.rewritten(), commit);
			if ((await this.reverted([commit])).length > 0) throw new IdeasError("git", "That change was undone already.");
			const start = (await this.git(["rev-parse", "HEAD"], this.dir)).trim();
			const keepNext = (await readSnapshot(this.dir)).nextId;
			try {
				// INDEX.md is generated, and every write rewrites it, so a conflict there is settled by generating it again;
				// one anywhere else means a later change touched the same lines.
				const failed = await this.git(["revert", "--no-commit", commit], this.dir).then(
					() => undefined,
					(error: Error) => error,
				);
				if (failed !== undefined) {
					const conflicted = (await this.git(["diff", "--name-only", "--diff-filter=U"], this.dir)).trim().split("\n").filter(Boolean);
					if (conflicted.length === 0 || conflicted.some((f) => f !== "INDEX.md")) {
						await this.git(["revert", "--abort"], this.dir).catch(() => undefined);
						throw new IdeasError("conflict", `Couldn't undo: a later change touched the same lines. ${failed.message}`);
					}
					await this.git(["checkout", "--ours", "--", "INDEX.md"], this.dir);
				}
				await writeFile(join(this.dir, "INDEX.md"), await renderIndex(this.dir, keepNext));
				await this.git(["add", "-A"], this.dir);
				// Git's prepared message: "Revert …" and "This reverts commit <sha>.", which reverted() looks for.
				await this.git(["-c", "core.editor=true", "commit", "-q", "--no-edit"], this.dir);
				const next = (await this.git(["rev-parse", "HEAD"], this.dir)).trim();
				await this.noteHead();
				return { commit: next };
			} catch (error) {
				await this.restore(start);
				throw error;
			}
		});
		void this.sync();
		return done;
	}

	/**
	 * Fetch, rebase local commits onto the upstream, push. Never throws: the outcome is in `status().sync`. Calls while
	 * one runs share a single follow-up run, so a sync that starts after this call has finished when it resolves.
	 */
	sync(): Promise<void> {
		if (this.syncQueued) return this.syncQueued;
		if (!this.syncRunning) {
			this.syncRunning = this.syncOnce().finally(() => {
				this.syncRunning = undefined;
				this.lastSyncEnd = this.now();
			});
			return this.syncRunning;
		}
		this.syncQueued = this.syncRunning.then(() => {
			this.syncQueued = undefined;
			return this.sync();
		});
		return this.syncQueued;
	}

	private async syncOnce(): Promise<void> {
		clearTimeout(this.retryTimer);
		this.retryTimer = undefined;
		if (this.closed) return;
		const status = await this.status().catch(() => undefined);
		if (!status || (status.state !== "ok" && status.state !== "dirty")) return;
		this.setSync({ ...this.syncState, state: "syncing", retryAt: undefined });
		try {
			const upstream = await this.upstream();
			for (let attempt = 0; ; attempt++) {
				await this.git(["fetch", "-q", upstream.remote], this.dir).catch((error: Error) => {
					throw new IdeasError("git", `Couldn't fetch: ${error.message}`);
				});
				const { head, ahead, warning } = await this.serial(() => this.catchUp());
				this.syncState.warning = warning;
				if (ahead === 0) break;
				try {
					await this.git(["push", "-q", upstream.remote, `${head}:refs/heads/${upstream.branch}`], this.dir);
					break;
				} catch (error) {
					const message = (error as Error).message;
					// GitHub moved between the fetch and the push: fetch and rebase again.
					if (/rejected|non-fast-forward|fetch first/i.test(message) && attempt < 2) continue;
					throw new IdeasError("git", `Couldn't push: ${message}`);
				}
			}
			this.failures = 0;
			this.setSync({ state: "idle", lastSynced: this.now(), warning: this.syncState.warning });
		} catch (error) {
			const full = error instanceof Error ? error.message : String(error);
			// Git's first line says what failed; the rest is its standard advice ("Please make sure you have the correct access rights…").
			const message = error instanceof IdeasError && error.code === "conflict" ? full : full.split("\n")[0]!.trim();
			if (error instanceof IdeasError && (error.code === "conflict" || error.code === "dirty")) {
				// Needs a person; the next write or Sync now tries again.
				this.setSync({ ...this.syncState, state: "conflict", error: message, retryAt: undefined });
				return;
			}
			const pending = await this.pending();
			let retryAt: number | undefined;
			if (pending && !this.closed) {
				const wait = this.retryMs[Math.min(this.failures, this.retryMs.length - 1)]!;
				this.failures++;
				retryAt = this.now() + wait;
				this.retryTimer = setTimeout(() => void this.sync(), wait);
				this.retryTimer.unref?.();
			}
			this.setSync({ ...this.syncState, state: "error", error: message, retryAt });
		}
	}

	/** Inside the lock: bring in the upstream's commits, rebasing local ones onto them. Answers what's left to push. */
	private async catchUp(): Promise<{ head: string; ahead: number; warning?: string }> {
		await this.requireClean();
		const [behind, ahead] = (await this.git(["rev-list", "--left-right", "--count", "@{u}...HEAD"], this.dir)).trim().split(/\s+/).map(Number);
		if (behind) {
			if (ahead) await this.rebase();
			else await this.git(["merge", "-q", "--ff-only", "@{u}"], this.dir);
			await this.noteHead();
		}
		const head = (await this.git(["rev-parse", "HEAD"], this.dir)).trim();
		const left = Number((await this.git(["rev-list", "--count", "@{u}..HEAD"], this.dir)).trim());
		return { head, ahead: left, warning: behind ? duplicateWarning(await readSnapshot(this.dir)) : this.syncState.warning };
	}

	/** Old commit id to new, for local commits a sync rebased: `.git/${REWRITTEN_FILE}` in the clone. */
	private async rewritten(): Promise<Record<string, string>> {
		try {
			return JSON.parse(await readFile(join(this.dir, ".git", REWRITTEN_FILE), "utf8")) as Record<string, string>;
		} catch {
			return {};
		}
	}

	/**
	 * Rebase onto the upstream, recording the new id of each local commit so Undo in a chat still finds it. INDEX.md is
	 * generated, so a conflict there is settled by generating it again.
	 */
	private async rebase() {
		const local = async () => (await this.git(["rev-list", "--reverse", "@{u}..HEAD"], this.dir)).trim().split("\n").filter(Boolean);
		const before = await local();
		await this.rebaseOnto();
		const after = await local();
		if (before.length === after.length && before.length) {
			const moved = await this.rewritten();
			before.forEach((old, i) => {
				if (old !== after[i]) moved[old] = after[i]!;
			});
			// Kept small: only the newest few hundred rewrites matter to chats on screen.
			const entries = Object.entries(moved).slice(-500);
			await writeFile(join(this.dir, ".git", REWRITTEN_FILE), JSON.stringify(Object.fromEntries(entries)));
		}
	}

	/**
	 * Captures on two machines between syncs both add a line at the end of inbox.md, which Git calls a conflict. A
	 * union merge keeps both lines. Set in the clone's own info/attributes, never in the repository.
	 */
	private async unionInbox() {
		const rel = (await this.git(["rev-parse", "--git-path", "info/attributes"], this.dir)).trim();
		const file = isAbsolute(rel) ? rel : join(this.dir, rel);
		const text = await readFile(file, "utf8").catch(() => "");
		if (/^inbox\.md merge=union$/m.test(text)) return;
		await mkdir(dirname(file), { recursive: true });
		await writeFile(file, `${text}${text && !text.endsWith("\n") ? "\n" : ""}inbox.md merge=union\n`);
	}

	private async rebaseOnto() {
		await this.unionInbox();
		const rebasing = () => existsSync(join(this.dir, ".git", "rebase-merge")) || existsSync(join(this.dir, ".git", "rebase-apply"));
		let failure = await this.git(["rebase", "-q", "@{u}"], this.dir).then(
			() => undefined,
			(error: Error) => error,
		);
		while (failure) {
			if (!rebasing()) throw new IdeasError("git", `Couldn't rebase: ${failure.message}`);
			const conflicted = (await this.git(["diff", "--name-only", "--diff-filter=U"], this.dir)).trim().split("\n").filter(Boolean);
			const others = conflicted.filter((f) => f !== "INDEX.md");
			if (others.length || !conflicted.length) {
				await this.git(["rebase", "--abort"], this.dir).catch(() => undefined);
				throw new IdeasError(
					"conflict",
					`Changes here to ${others.join(", ") || "the ideas"} conflict with changes from another machine. Sort them out in ${this.dir} (git pull --rebase), then sync.`,
				);
			}
			const stage = (n: number) => this.git(["show", `:${n}:INDEX.md`], this.dir).catch(() => "");
			const [ours, theirs] = [await stage(2), await stage(3)];
			const keepNext = Math.max(parseIndex(ours).nextId ?? 0, parseIndex(theirs).nextId ?? 0);
			// renderIndex reads the old summaries from INDEX.md, so give it one without conflict markers.
			await writeFile(join(this.dir, "INDEX.md"), theirs || ours);
			await writeFile(join(this.dir, "INDEX.md"), await renderIndex(this.dir, keepNext));
			await this.git(["add", "INDEX.md"], this.dir);
			// Messages start with "#16: …", which Git would strip as a comment line when it commits; use another comment character.
			failure = await this.git(["-c", "core.editor=true", "-c", "core.commentChar=;", "rebase", "--continue"], this.dir).then(
				() => undefined,
				(error: Error) => error,
			);
		}
	}

	/** The upstream's remote and branch, e.g. origin and master. */
	private async upstream(): Promise<{ remote: string; branch: string }> {
		const name = (await this.git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], this.dir).catch(() => "")).trim();
		const slash = name.indexOf("/");
		if (slash <= 0) throw new IdeasError("conflict", `The branch in ${this.dir} has no upstream, so changes can't sync. Set one: git branch -u origin/master`);
		return { remote: name.slice(0, slash), branch: name.slice(slash + 1) };
	}

	/** Local commits the upstream doesn't have, as far as the last fetch knows. */
	private async pending(): Promise<number> {
		const count = await this.git(["rev-list", "--count", "@{u}..HEAD"], this.dir).catch(() => "0");
		return Number(count.trim()) || 0;
	}

	private setSync(next: Omit<IdeasSync, "pending">) {
		this.syncState = next;
		for (const l of this.listeners) l();
	}

	private serial<T>(work: () => Promise<T>): Promise<T> {
		const run = this.queue.then(work, work);
		this.queue = run.catch(() => undefined);
		return run;
	}

	private async usable() {
		const status = await this.status();
		if (status.state === "missing" || status.state === "not_repo" || status.state === "no_remote") {
			throw new IdeasError(status.state === "no_remote" ? "not_repo" : status.state, status.detail ?? "The ideas clone isn't usable.");
		}
	}

	private async requireClean() {
		if ((await this.git(["status", "--porcelain"], this.dir)).trim()) {
			throw new IdeasError("dirty", `Uncommitted changes in ${this.dir}. Commit or discard them, then try again.`);
		}
	}

	/** Back to `commit`, dropping what this write did. The clone was clean when it started. */
	private async restore(commit: string) {
		await this.git(["reset", "-q", "--hard", commit], this.dir).catch(() => undefined);
		await this.git(["clean", "-q", "-fd"], this.dir).catch(() => undefined);
	}
}

/** Pi Desktop's name, kept: in a clone both have written, Undo in either finds a commit a sync rebased. */
const REWRITTEN_FILE = "pi-desktop-rewritten.json";

/** Follow `commit` through rebases to its id now. */
function current(moved: Record<string, string>, commit: string): string {
	for (let i = 0; i < 50 && moved[commit]; i++) commit = moved[commit]!;
	return commit;
}

/** Two machines can give out the same number between syncs; say which, since only a person can renumber. */
function duplicateWarning(snapshot: IdeasSnapshot): string | undefined {
	const seen = new Set<number>();
	const twice = new Set<number>();
	for (const id of [...snapshot.ideas.map((i) => i.id), ...snapshot.captures.map((c) => c.id)]) (seen.has(id) ? twice : seen).add(id);
	if (!twice.size) return undefined;
	const list = [...twice].sort((a, b) => a - b).map((id) => `#${id}`);
	return `${list.join(", ")} ${list.length === 1 ? "is" : "are"} used twice, by changes made on two machines between syncs. Renumber one by hand.`;
}

const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

/** An idea's folder: ideas/<file name without .md>/. */
export function ideaFolder(path: string): string {
	return path.replace(/\.md$/, "");
}

/** Images anywhere under an idea's folder, relative to it, sorted. */
export async function ideaImages(dir: string, ideaPath: string): Promise<string[]> {
	const root = join(dir, ideaFolder(ideaPath));
	const found: string[] = [];
	const walk = async (rel: string) => {
		const entries = await readdir(join(root, rel), { withFileTypes: true }).catch(() => []);
		for (const e of entries) {
			if (e.name.startsWith(".")) continue;
			const child = rel ? `${rel}/${e.name}` : e.name;
			if (e.isDirectory()) await walk(child);
			else if (e.isFile() && imageType(e.name)) found.push(child);
		}
	};
	await walk("");
	return found.sort();
}

export function imageType(name: string): string | undefined {
	const dot = name.lastIndexOf(".");
	return dot === -1 ? undefined : IMAGE_TYPES[name.slice(dot).toLowerCase()];
}

/** Through symlinks: on macOS git answers /private/var/… for a dir under /var. */
function sameDir(a: string, b: string): boolean {
	const norm = (p: string) => {
		try {
			return realpathSync(p);
		} catch {
			return p.replace(/\/+$/, "");
		}
	};
	return norm(a) === norm(b);
}

// ---- Parsing ----

/** Frontmatter between --- lines: `key: value`, with `[a, b]` lists. */
export function parseFrontmatter(text: string): { fields: Record<string, string>; body: string } {
	const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
	if (!match) return { fields: {}, body: text };
	const fields: Record<string, string> = {};
	for (const line of match[1]!.split("\n")) {
		const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
		if (kv) fields[kv[1]!] = kv[2]!.trim();
	}
	return { fields, body: text.slice(match[0].length) };
}

export function parseList(value: string | undefined): string[] {
	if (!value) return [];
	const inner = value.replace(/^\[|\]$/g, "");
	return inner.split(",").map((s) => s.trim()).filter(Boolean);
}

export function parseIdea(text: string, path: string): IdeaFile | undefined {
	const { fields, body } = parseFrontmatter(text);
	const id = Number(fields.id);
	if (!Number.isSafeInteger(id) || id <= 0) return undefined;
	const optional = (key: string) => (fields[key] ? fields[key] : undefined);
	return {
		id,
		title: fields.title || path,
		status: fields.status || "raw",
		areas: parseList(fields.areas),
		created: optional("created"),
		updated: optional("updated"),
		project: optional("project"),
		summary: optional("summary"),
		chats: parseList(fields.chats).map(Number).filter((n) => Number.isSafeInteger(n) && n >= 0),
		sessions: parseList(fields.sessions).filter((s) => /^[^/\s]+\/\d+$/.test(s)),
		path,
		fields,
		body,
	};
}

/** `- #12 2026-10-21: text` lines. */
export function parseInbox(text: string): Capture[] {
	const captures: Capture[] = [];
	for (const line of text.split("\n")) {
		const m = /^- #(\d+) (\d{4}-\d{2}-\d{2}): (.*)$/.exec(line);
		if (m) captures.push({ id: Number(m[1]), date: m[2]!, text: m[3]!.trim() });
	}
	return captures;
}

/** The "Next ID: **N**" line and each row's summary, from the current INDEX.md. */
export function parseIndex(text: string): { nextId?: number; summaries: Map<number, string> } {
	const next = /Next ID: \*\*(\d+)\*\*/.exec(text);
	const summaries = new Map<number, string>();
	for (const line of text.split("\n")) {
		const cells = line.split(/(?<!\\)\|/).map((c) => c.trim());
		// | ID | Idea | Status | Areas | Summary |
		if (cells.length >= 7 && /^\d+$/.test(cells[1]!)) summaries.set(Number(cells[1]), cells[5]!.replace(/\\\|/g, "|"));
	}
	return { nextId: next ? Number(next[1]) : undefined, summaries };
}

async function readText(path: string): Promise<string> {
	return readFile(path, "utf8").catch(() => "");
}

export async function readSnapshot(dir: string): Promise<IdeasSnapshot> {
	const names = await readdir(join(dir, "ideas")).catch(() => [] as string[]);
	const ideas: IdeaFile[] = [];
	for (const name of names.filter((n) => n.endsWith(".md")).sort()) {
		const idea = parseIdea(await readText(join(dir, "ideas", name)), `ideas/${name}`);
		if (idea) ideas.push(idea);
	}
	ideas.sort((a, b) => a.id - b.id);
	const captures = parseInbox(await readText(join(dir, "inbox.md")));
	const index = parseIndex(await readText(join(dir, "INDEX.md")));
	const highest = Math.max(0, ...ideas.map((i) => i.id), ...captures.map((c) => c.id));
	// A deleted idea's number stays retired, so the recorded next ID never goes back.
	return { ideas, captures, nextId: Math.max(highest + 1, index.nextId ?? 0) };
}

// ---- INDEX.md ----

const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");

/**
 * INDEX.md from the files: a row per idea file, summary from its frontmatter (or, until
 * every file has one, the row's current summary), and the next free ID.
 */
export async function renderIndex(dir: string, minNextId = 0): Promise<string> {
	const read = await readSnapshot(dir);
	const snapshot = { ...read, nextId: Math.max(read.nextId, minNextId) };
	const { summaries } = parseIndex(await readText(join(dir, "INDEX.md")));
	const rows = snapshot.ideas.map((idea) => {
		const summary = idea.summary ?? summaries.get(idea.id) ?? "";
		return `| ${idea.id} | [${cell(idea.title)}](${idea.path}) | ${cell(idea.status)} | ${cell(idea.areas.join(", "))} | ${cell(summary)} |`;
	});
	return [
		"# Index",
		"",
		"| ID | Idea | Status | Areas | Summary |",
		"|----|------|--------|-------|---------|",
		...rows,
		"",
		`Inbox one-liners in \`inbox.md\` also carry IDs from the same sequence. Next ID: **${snapshot.nextId}**`,
		"",
	].join("\n");
}
