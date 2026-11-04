// Shipping a sandbox session's work, after Amp's Ship: the sandbox does the work that needs judgment and the push
// happens here, so the sandbox never holds a key.
//
// 1. Here: fetch the project's upstream, and put the branch to land on (`origin/main`, say) into the sandbox as
//    `refs/aludra/base` (src/sandboxes.ts receiveBase).
// 2. In the sandbox, as a message to the session: commit anything uncommitted, rebase onto refs/aludra/base,
//    resolve conflicts (asking when one needs a decision), run the tests, and finish with a SHIP-READY or
//    SHIP-BLOCKED line.
// 3. Here: fetch the result into `sandbox/N` (forced, since the rebase rewrote it), check it sits on the base, and
//    push it: to the base branch (`main` mode), or to a branch of its own with a pull request (`branch` mode).
//    Then the local branch is fast-forwarded when that's safe.
//
// Pressing Ship is the approval for the push, so it doesn't wait in the approvals queue as an agent's push would.
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { AssistantEntry } from "@earendil-works/pi-durable";
import type { Host, SessionRecord } from "./host.ts";
import { fastForward, type MergeResult, run, type SyncResult } from "./sandboxes.ts";

export type ShipMode = "main" | "branch";

/**
 * Why a ship stopped: the session didn't say it was ready (`blocked`), the upstream moved while it shipped
 * (`upstream_moved`), reaching the upstream failed (`push_failed`), or a check this machine makes before pushing failed
 * (`check_failed`), such as files left uncommitted or a branch that isn't on the upstream.
 */
export type ShipFailure = "blocked" | "upstream_moved" | "push_failed" | "check_failed";

export type ShipResult =
	| { shipped: true; mode: ShipMode; pushed: string; head: string; commits: number; pr?: string; local?: MergeResult }
	| { shipped: false; kind: ShipFailure; reason: string };

/** A failure of `kind`, thrown inside ship and returned from it. */
class Stop extends Error {
	readonly kind: ShipFailure;
	constructor(kind: ShipFailure, reason: string) {
		super(reason);
		this.kind = kind;
	}
}

/** The message that asks the session to get its work ready to land on `base`, with the user's `note` if any. */
export function shipPrompt(base: string, sha: string, note?: string): string {
	return [
		...(note === undefined || note.trim() === "" ? [] : [`A note from the user about this ship: ${note.trim()}`, ""]),
		`Ship this work: get it ready to land on ${base}, which is ${sha.slice(0, 12)} and is in this repository as refs/aludra/base.`,
		"1. Commit anything uncommitted that belongs to the work, with a clear message. Leave out stray files (scratch notes, logs, build output).",
		"2. Rebase the work onto refs/aludra/base: `git rebase refs/aludra/base`. Resolve conflicts by keeping both sides' intent; if a conflict needs a decision only the user can make, stop and ask.",
		"3. Run the project's tests and checks. If one fails, fix it, unless it also fails on refs/aludra/base without this work; check that before calling it unrelated.",
		"4. Don't push, and don't change git remotes: the host pushes once you're done.",
		"End your reply with one line on its own: `SHIP-READY` when HEAD is the rebased, tested work, or `SHIP-BLOCKED: <why>` when it isn't.",
	].join("\n");
}

/** What the session's last answer said about readiness. */
export function shipVerdict(answer: string | undefined): { ready: true } | { ready: false; reason: string } {
	const lines = (answer ?? "").trim().split("\n").map((l) => l.trim().replace(/^`|`$/g, ""));
	const last = [...lines].reverse().find((l) => /^SHIP-(READY|BLOCKED)\b/.test(l));
	if (last === undefined) return { ready: false, reason: "the session didn't say SHIP-READY" };
	if (last.startsWith("SHIP-READY")) return { ready: true };
	return { ready: false, reason: last.replace(/^SHIP-BLOCKED:?\s*/, "") || "the session said it's blocked" };
}

/** The upstream to land on for the local checkout `local`: its branch's upstream, else origin's default branch. */
export async function shipBase(local: string): Promise<{ remote: string; branch: string; ref: string }> {
	const git = (...args: string[]) => run("git", ["-C", local, ...args]).then((s) => s.trim());
	const upstream = await git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}").catch(() => "");
	if (upstream !== "" && upstream.includes("/")) {
		const remote = upstream.split("/")[0]!;
		return { remote, branch: upstream.slice(remote.length + 1), ref: `refs/remotes/${upstream}` };
	}
	const head = await git("symbolic-ref", "--short", "refs/remotes/origin/HEAD").catch(() => "");
	if (head !== "") return { remote: "origin", branch: head.slice("origin/".length), ref: `refs/remotes/${head}` };
	throw new Error(`${local} has no upstream to ship to: set one with git branch --set-upstream-to, or push it once`);
}

export type ShipOptions = {
	mode?: ShipMode;
	/** The user's note, added to the ship prompt. */
	note?: string;
	/** Each line of progress, for the CLI. */
	onProgress?: (line: string) => void;
	/** Sends the prompt to the session and resolves with its answer's text once the run ends; the host's by default. */
	ask?: (id: number, prompt: string) => Promise<{ status: string; answer?: string }>;
};

/** What a ship needs of the host. */
export type ShipHost = {
	sessions: { get(id: number): Promise<SessionRecord | undefined> };
	sandboxes: {
		sync(id: number, into?: string, options?: { force?: boolean }): Promise<SyncResult>;
		receiveBase(id: number, ref: string): Promise<string>;
	};
};

/** Sends `prompt` to session `id` and waits for its run to end: its status, and its answer's text when it ended with one. */
export async function askSession(host: Pick<Host, "submit" | "harness">, id: number, prompt: string, requestId?: string): Promise<{ status: string; answer?: string }> {
	const settled = await (await host.submit(id, prompt, requestId === undefined ? {} : { requestId })).wait(context);
	if (settled.status !== "done" || settled.type !== "input") return { status: settled.status };
	const entry = await host.harness.commit((tx) => tx.entry(settled.answer), context);
	const message = AssistantEntry.is(entry) ? entry.model?.[0] : undefined;
	if (message?.role !== "assistant" || message.stopReason === "error") return { status: "failed" };
	if (message.stopReason === "aborted") return { status: "stopped" };
	return { status: "done", answer: message.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("").trim() };
}

/**
 * Ships sandbox session `id`'s work (see the top of this file). Never throws: anything that goes wrong comes back as a
 * failure with its kind.
 */
export async function ship(host: ShipHost, id: number, options: ShipOptions & { ask: NonNullable<ShipOptions["ask"]> }): Promise<ShipResult> {
	try {
		return await shipping(host, id, options);
	} catch (error) {
		if (error instanceof Stop) return { shipped: false, kind: error.kind, reason: error.message };
		// Anything else is git or gh failing to reach the upstream, or the sandbox.
		return { shipped: false, kind: "push_failed", reason: error instanceof Error ? error.message : String(error) };
	}
}

async function shipping(host: ShipHost, id: number, options: ShipOptions & { ask: NonNullable<ShipOptions["ask"]> }): Promise<ShipResult> {
	const say = options.onProgress ?? (() => {});
	const mode = options.mode ?? "main";
	const record = await host.sessions.get(id);
	if (record === undefined) throw new Stop("check_failed", `no session ${id}`);
	if (record.sandbox === undefined || record.source === undefined) throw new Stop("check_failed", `session ${id} isn't a sandbox session of a project with its sandbox ready`);
	if (record.sandboxRemoved === true) throw new Stop("check_failed", `session ${id}'s sandbox was deleted when it was archived`);
	const local = record.source;
	const git = (...args: string[]) => run("git", ["-C", local, ...args]).then((s) => s.trim());

	const base = await shipBase(local).catch((error: Error) => {
		throw new Stop("check_failed", error.message);
	});
	say(`fetching ${base.remote}/${base.branch}`);
	await git("fetch", "--quiet", base.remote, base.branch);
	const sha = await host.sandboxes.receiveBase(id, base.ref);
	say(`asking session ${id} to rebase onto ${base.remote}/${base.branch} (${sha.slice(0, 12)}) and run the tests`);

	const answered = await options.ask(id, shipPrompt(`${base.remote}/${base.branch}`, sha, options.note));
	if (answered.status !== "done") throw new Stop("blocked", `the session's run ended ${answered.status}`);
	const verdict = shipVerdict(answered.answer);
	if (!verdict.ready) throw new Stop("blocked", `not ready: ${verdict.reason}`);

	const synced = await host.sandboxes.sync(id, undefined, { force: true });
	if (synced.uncommitted > 0) throw new Stop("check_failed", `the sandbox still has ${synced.uncommitted} uncommitted file${synced.uncommitted === 1 ? "" : "s"}; nothing pushed`);
	const onBase = await git("merge-base", "--is-ancestor", sha, synced.head).then(() => true, () => false);
	if (!onBase) throw new Stop("check_failed", `${synced.branch} isn't on ${base.remote}/${base.branch}; the rebase didn't happen, nothing pushed`);
	const commits = Number(await git("rev-list", "--count", `${sha}..${synced.head}`));
	if (commits === 0) throw new Stop("check_failed", `nothing to ship: ${synced.branch} has no commits beyond ${base.remote}/${base.branch}`);

	if (mode === "main") {
		say(`pushing ${commits} commit${commits === 1 ? "" : "s"} to ${base.remote}/${base.branch}`);
		// Without force: if the base moved since the fetch, this fails and the user ships again.
		await git("push", "--quiet", base.remote, `${synced.head}:refs/heads/${base.branch}`).catch((error: Error) => {
			if (/rejected|fetch first|non-fast-forward/.test(error.message)) throw new Stop("upstream_moved", `${base.remote}/${base.branch} moved while shipping; ship again to rebase onto it`);
			throw new Stop("push_failed", error.message);
		});
		await git("fetch", "--quiet", base.remote, base.branch).catch(() => {});
		const current = await git("symbolic-ref", "--quiet", "--short", "HEAD").catch(() => "");
		const localResult = current === base.branch ? await fastForward(local, synced.branch) : undefined;
		return { shipped: true, mode, pushed: `${base.remote}/${base.branch}`, head: synced.head, commits, ...(localResult === undefined ? {} : { local: localResult }) };
	}

	const branch = `${synced.branch}-${synced.head.slice(0, 7)}`.replace(/^sandbox\//, "sandbox-");
	say(`pushing ${commits} commit${commits === 1 ? "" : "s"} to ${base.remote}/${branch}`);
	await git("push", "--quiet", base.remote, `${synced.head}:refs/heads/${branch}`);
	const pr = await run("gh", ["pr", "create", "--repo", await repoOf(local, base.remote), "--base", base.branch, "--head", branch, "--fill-first"]).then((s) => s.trim().split("\n").at(-1), (error: Error) => {
		say(`couldn't open a pull request: ${error.message.split("\n").at(-1)}`);
		return undefined;
	});
	return { shipped: true, mode, pushed: `${base.remote}/${branch}`, head: synced.head, commits, ...(pr === undefined ? {} : { pr }) };
}

/** `owner/repo` of a GitHub remote, for gh. */
async function repoOf(local: string, remote: string): Promise<string> {
	const url = (await run("git", ["-C", local, "remote", "get-url", remote])).trim();
	const match = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url);
	if (match === null) throw new Error(`${remote} isn't on GitHub (${url}); ship to main instead`);
	return match[1]!;
}

/** A ship going on, kept in the session's record so a restart can finish it. */
export type Shipping = { requestId: string; mode: ShipMode; note?: string; startedAt: number };

export type ShipsOptions = ShipHost & {
	/** Each session's state, to refuse a ship while it runs. */
	states(): Promise<Map<number, "running" | "waiting" | "idle">>;
	/** Sends the ship prompt with `requestId` and waits for the run (askSession). */
	ask(id: number, prompt: string, requestId: string): Promise<{ status: string; answer?: string }>;
	/** Records the ship going on in session `id`'s record, or clears it with undefined. */
	mark(id: number, shipping: Shipping | undefined): Promise<void>;
	log?: (line: string) => void;
};

/** A ship that can't start, and why: `busy` while the session runs or ships, `bad_request` otherwise. */
export class ShipRefused extends Error {
	readonly code: "busy" | "bad_request";
	constructor(code: "busy" | "bad_request", message: string) {
		super(message);
		this.code = code;
	}
}

/**
 * Ships started from clients: one at a time per session, recorded so a restart picks each up again with the same
 * prompt request, which Pi Durable answers with the submission it already has. Listeners hear each ship's result.
 */
export function createShips(options: ShipsOptions) {
	const going = new Map<number, Promise<ShipResult>>();
	const listeners = new Set<(id: number, result: ShipResult) => void>();
	const log = options.log ?? ((line: string) => console.error(line));

	function run(id: number, shipping: Shipping, onProgress?: (line: string) => void): Promise<ShipResult> {
		const done = (async () => {
			const result = await ship(options, id, {
				mode: shipping.mode,
				...(shipping.note === undefined ? {} : { note: shipping.note }),
				...(onProgress === undefined ? {} : { onProgress }),
				ask: (session, prompt) => options.ask(session, prompt, shipping.requestId),
			});
			await options.mark(id, undefined).catch((error) => log(`[ship] session ${id}: ${error instanceof Error ? error.message : String(error)}`));
			log(result.shipped ? `[ship] session ${id}: ${result.commits} commit${result.commits === 1 ? "" : "s"} to ${result.pushed}` : `[ship] session ${id} stopped (${result.kind}): ${result.reason}`);
			for (const listener of listeners) listener(id, result);
			return result;
		})().finally(() => going.delete(id));
		going.set(id, done);
		return done;
	}

	return {
		/**
		 * Starts shipping session `id` and resolves once it's started, with the result's promise; throws ShipRefused when it
		 * can't start: no sandbox, or the session running or already shipping.
		 */
		async start(id: number, request: { mode: ShipMode; note?: string; onProgress?: (line: string) => void }): Promise<{ done: Promise<ShipResult> }> {
			const record = await options.sessions.get(id);
			if (record === undefined) throw new ShipRefused("bad_request", `no session ${id}`);
			if (record.sandboxNumber === undefined && record.sandbox === undefined) throw new ShipRefused("bad_request", `session ${id} isn't in a sandbox`);
			if (record.sandbox === undefined) throw new ShipRefused("bad_request", `session ${id}'s sandbox isn't ready`);
			if (record.sandboxRemoved === true) throw new ShipRefused("bad_request", `session ${id}'s sandbox was deleted when it was archived`);
			if (record.source === undefined) throw new ShipRefused("bad_request", `session ${id} has no project to ship from`);
			if (going.has(id)) throw new ShipRefused("busy", `session ${id} is already shipping`);
			if ((await options.states()).get(id) !== "idle") throw new ShipRefused("busy", `session ${id} is running; ship once it's done`);
			const shipping: Shipping = { requestId: `ship:${id}:${Date.now().toString(36)}`, mode: request.mode, startedAt: Date.now(), ...(request.note === undefined ? {} : { note: request.note }) };
			await options.mark(id, shipping);
			return { done: run(id, shipping, request.onProgress) };
		},
		/** Picks up ships a restart cut off, from the records that still carry one. */
		resume(records: readonly SessionRecord[]) {
			for (const record of records) {
				if (record.shipping !== undefined && !going.has(record.id)) void run(record.id, record.shipping);
			}
		},
		shipping: (id: number) => going.has(id),
		onShipped(listener: (id: number, result: ShipResult) => void): () => void {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		/** Resolves once the ships going now are done; for tests. */
		settled: () => Promise.all(going.values()).then(() => undefined),
	};
}
