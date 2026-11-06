// Shipping a sandbox session's work, after Amp's Ship: the sandbox does the work that needs judgment and the push
// happens here, so the sandbox never holds a key.
//
// 1. Here: fetch the project's upstream, and put the branch to land on (`origin/main`, say) into the sandbox as
//    `refs/aludra/base` (src/sandboxes.ts receiveBase).
// 2. In the sandbox, as a message to the session: commit anything uncommitted, rebase onto refs/aludra/base,
//    resolve conflicts (asking when one needs a decision), and finish with a SHIP-READY or SHIP-BLOCKED line.
// 3. Here: fetch the result into `sandbox/N` (forced, since the rebase rewrote it), check it sits on the base, and run
//    the project's checks in the sandbox at the rebased HEAD: the declared ones, else the passing test and build
//    commands of the work's last turn. A check that fails is run again at the base, in a worktree beside the project:
//    failing there too, it isn't the work's and the ship goes on, saying so (`baseFailures`); passing there, the ship
//    stops as `check_failed` with nothing pushed.
// 4. Here: push it: to the base branch (`main` mode), or to a branch of its own with a pull request (`branch` mode).
//    Then the local branch is fast-forwarded when that's safe. Work that has nothing beyond the base once rebased (it
//    landed already, or changed nothing) lands with no push and `commits: 0`: there's nothing left to do.
//
// Pressing Ship is the approval for the push, so it doesn't wait in the approvals queue as an agent's push would.
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { AssistantEntry } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { posix } from "node:path";
import type { Host, SessionRecord } from "./host.ts";
import { CHECK_TIMEOUT_S, type Check, parseProjectConfig, type ProjectConfig, runChecks } from "./results.ts";
import { fastForward, type MergeResult, run, type SyncResult } from "./sandboxes.ts";

export type ShipMode = "main" | "branch";

/**
 * Why a ship stopped: the session didn't say it was ready (`blocked`), the upstream moved while it shipped
 * (`upstream_moved`), reaching the upstream failed (`push_failed`), or a check this machine makes before pushing failed
 * (`check_failed`), such as files left uncommitted, a branch that isn't on the upstream, or a project check that fails
 * with the work and passes without it.
 */
export type ShipFailure = "blocked" | "upstream_moved" | "push_failed" | "check_failed";

/** A check that failed at the ship's HEAD and at the base too, so not the work's: its name and its output's first line. */
export type BaseFailure = { name: string; reason: string };

/**
 * What a landed ship adds about its checks: `baseFailures` when some failed on the base too (absent when none did),
 * and `unchecked` when there were none to run, declared or from the work's turn.
 */
export type ShipChecked = { baseFailures?: BaseFailure[]; unchecked?: true };

export type ShipResult =
	| ({ shipped: true; mode: ShipMode; pushed: string; head: string; commits: number; pr?: string; local?: MergeResult } & ShipChecked)
	| { shipped: false; kind: ShipFailure; reason: string };

/** The latest ship that landed, kept on the session's record until another lands; `commits: 0` when it was all upstream already. */
export type ShipLanded = { at: number; to: ShipMode; pushed: string; head: string; commits: number; pr?: string } & ShipChecked;
/** The latest ship that stopped short, kept on the record until the next one starts or lands. */
export type ShipStopped = { at: number; kind: ShipFailure; reason: string };

/** What the record keeps of a ship's `result`, ended at `at`. */
export function shipOutcome(result: ShipResult, at: number): { shipped: ShipLanded } | { shipStopped: ShipStopped } {
	return result.shipped
		? { shipped: { at, to: result.mode, pushed: result.pushed, head: result.head, commits: result.commits, ...(result.pr === undefined ? {} : { pr: result.pr }), ...checkedOf(result) } }
		: { shipStopped: { at, kind: result.kind, reason: result.reason } };
}

/** A result's ShipChecked fields, without the empty ones. */
export function checkedOf(result: ShipChecked): ShipChecked {
	return { ...(result.baseFailures === undefined || result.baseFailures.length === 0 ? {} : { baseFailures: result.baseFailures }), ...(result.unchecked === true ? { unchecked: true as const } : {}) };
}

/** What a landed ship's checks add to its line or sentence: "types fails on main too: cargo: not found", or "". */
function checkedWords(shipped: ShipLanded): string {
	const failures = shipped.baseFailures ?? [];
	if (failures.length === 1) return `${failures[0]!.name} fails on ${baseOf(shipped)} too: ${failures[0]!.reason}`;
	if (failures.length > 1) return `${failures.map((f) => f.name).join(", ")} fail on ${baseOf(shipped)} too`;
	// A ship with nothing to check carries `unchecked` but reads as before, since clients match these words.
	return "";
}

/** Where a landed ship went, in words: "main", or "sandbox-4-ab12cd3 for review". */
function landedWhere(shipped: ShipLanded): string {
	const branch = shipped.pushed.replace(/^[^/]+\//, "");
	return shipped.to === "branch" ? `${branch} for review` : branch;
}

/** The branch a landed ship with nothing to push found its work on, or the base it landed on: "main". */
function baseOf(shipped: ShipLanded): string {
	if (shipped.to === "main") return shipped.pushed.replace(/^[^/]+\//, "");
	return "the base";
}

/** A ship's outcome as a sentence, for a summary or a notification: "Shipped to main: 2 commits.", "Ship stopped: …". */
export function shipSentence(outcome: { shipped: ShipLanded } | { shipStopped: ShipStopped }): string {
	if ("shipped" in outcome) {
		const { commits } = outcome.shipped;
		if (commits === 0) return `Nothing to ship: it's all on ${baseOf(outcome.shipped)} already.`;
		const checked = checkedWords(outcome.shipped);
		return `Shipped to ${landedWhere(outcome.shipped)}: ${commits} commit${commits === 1 ? "" : "s"}.${checked === "" ? "" : ` ${checked[0]!.toUpperCase()}${checked.slice(1)}.`}`;
	}
	return `Ship stopped: ${outcome.shipStopped.reason}`;
}

/** A ship's outcome as a task's line: "Shipped to main · 2 commits", "Ship stopped · …". */
export function shipLine(outcome: { shipped: ShipLanded } | { shipStopped: ShipStopped }): string {
	if ("shipped" in outcome) {
		const { commits } = outcome.shipped;
		if (commits === 0) return `Already on ${baseOf(outcome.shipped)}`;
		const checked = checkedWords(outcome.shipped);
		const line = `Shipped to ${landedWhere(outcome.shipped)} · ${commits} commit${commits === 1 ? "" : "s"}${checked === "" ? "" : ` · ${checked}`}`;
		return line.length > 160 ? `${line.slice(0, 159)}…` : line;
	}
	const reason = outcome.shipStopped.reason;
	const short = /^(.+?[.!?])(\s|$)/.exec(reason)?.[1] ?? reason;
	return `Ship stopped · ${short.length > 120 ? `${short.slice(0, 119)}…` : short}`;
}

/** Whether `text` is a ship prompt (shipPrompt), so the turn it starts is a ship's. */
export function isShipPrompt(text: string): boolean {
	return /^Ship this work: get it ready to land on /m.test(text) && text.includes("SHIP-READY");
}

/** Longest a ship's command may run: a check that hangs shouldn't hold the task. */
export const SHIP_COMMAND_S = 5 * 60;

/** The arguments a bash call runs with while its session ships: its own timeout, cut to SHIP_COMMAND_S; undefined to leave it. */
export function shipTimeout(call: { name: string; arguments: Record<string, unknown> }): Record<string, unknown> | undefined {
	if (call.name !== "bash") return undefined;
	const asked = typeof call.arguments.timeout === "number" ? call.arguments.timeout : Infinity;
	return asked <= SHIP_COMMAND_S ? undefined : { ...call.arguments, timeout: SHIP_COMMAND_S };
}

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
		`3. Once you say SHIP-READY, the host runs the project's checks at your HEAD and tells a failure of the work from one the base has too, so you needn't run them to finish. Run whatever you need while fixing things, such as after resolving a conflict. Don't change the system (sysctl, packages, limits, swap), and don't dig into the machine. Each command is stopped after ${SHIP_COMMAND_S / 60} minutes.`,
		"4. Don't push, and don't change git remotes: the host pushes once you're done.",
		"Keep a plan block as for any work, with these steps (bring in the upstream, rebase, ready), so the user sees which one you're on.",
		"End your reply with one line on its own: `SHIP-READY` when HEAD is the rebased work, or `SHIP-BLOCKED: <why>` when it isn't. When there's nothing beyond refs/aludra/base after the rebase (the work is upstream already, or changed nothing) and nothing is uncommitted, that's `SHIP-READY` too: the host sees there's nothing to push and says so. When you're blocked on a decision only the user can make, put a result block after it, as for any reply that asks, whose question names the choices as options.",
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
		/** Session `id`'s sandbox, to run checks in: its environment and the project's directory there. */
		env(id: number): Promise<{ env: ExecutionEnv; dir: string }>;
	};
	/**
	 * The test, build, type-check and lint commands of session `id`'s last turn that wasn't a ship's, with how each went
	 * (src/results.ts callCommands): the checks when the project declares none.
	 */
	turnCommands(id: number): Promise<(Check & { command: string })[]>;
	/** How long each check may run, in seconds; CHECK_TIMEOUT_S, as after each answer. */
	checkTimeout?: number;
};

/**
 * Whether `command` names a path outside `dir`: an absolute one elsewhere, one under `~`, or a relative one that climbs
 * out. Such a command (a spec the agent wrote in /tmp, say) can't be rerun as the project's.
 */
export function reachesOutside(command: string, dir: string): boolean {
	const root = posix.normalize(dir).replace(/\/$/, "");
	for (const raw of command.split(/\s+/)) {
		const token = raw.replace(/^['"]|['"]$/g, "").replace(/^--?[\w-]+=/, "").replace(/^['"]|['"]$/g, "");
		if (token === "" || /^[a-z][\w+.-]*:\/\//i.test(token)) continue;
		if (token.startsWith("~") || token.startsWith("$HOME")) return true;
		if (token.startsWith("/")) {
			const at = posix.normalize(token);
			if (at !== root && !at.startsWith(`${root}/`)) return true;
			continue;
		}
		if (token.includes("..")) {
			const at = posix.normalize(posix.join(root, token));
			if (at !== root && !at.startsWith(`${root}/`)) return true;
		}
	}
	return false;
}

/** The checks a ship runs: the ones `.agents/project.json` declares at HEAD, else the turn's own that passed and stay in the project. */
export function shipChecks(declared: ProjectConfig["checks"], turn: readonly (Check & { command: string })[], dir: string): ProjectConfig["checks"] {
	if (declared.length > 0) return declared;
	return turn.filter((c) => c.ok && !reachesOutside(c.command, dir)).map((c) => ({ name: c.name, command: c.command }));
}

/** The first line of a failing check's output with something on it, cut short: what a ship's outcome says of it. */
export function firstLine(check: Check): string {
	const line = (check.detail ?? "").replace(/^…/, "").split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "it failed";
	return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

/**
 * Bash that makes a worktree WT of COMMIT beside the project in DIR, borrows the project's node_modules as hard links
 * (as src/shots.ts does for its `before` side), or installs afresh when INSTALL is 1, and exits 3 when it can't.
 */
const BASE_WORKTREE = String.raw`set -u
rm -rf "$WT"
git -C "$DIR" worktree add -q --detach "$WT" "$COMMIT" >/dev/null 2>&1 || { echo "no worktree at $COMMIT"; exit 3; }
cd "$WT"
if [ "$INSTALL" = 1 ]; then
	if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile --prefer-offline >/dev/null 2>&1
	elif [ -f package-lock.json ]; then npm ci --prefer-offline >/dev/null 2>&1
	elif [ -f package.json ]; then pnpm install --prefer-offline >/dev/null 2>&1
	fi
else
	(cd "$DIR" && find . -path ./.git -prune -o -name node_modules -type d -prune -print) | while read -r nm; do
		[ -d "$WT/$(dirname "$nm")" ] && [ ! -e "$WT/$nm" ] && { cp -al "$DIR/$nm" "$WT/$nm" 2>/dev/null || cp -a "$DIR/$nm" "$WT/$nm"; }
	done
fi
exit 0
`;

const REMOVE_WORKTREE = String.raw`git -C "$DIR" worktree remove --force "$WT" >/dev/null 2>&1 || rm -rf "$WT"
git -C "$DIR" worktree prune
`;

/** Runs bash `script` in the sandbox with `vars`: its exit code and output. */
async function sh(env: ExecutionEnv, script: string, vars: Record<string, string>, cwd: string, timeout = 120): Promise<{ code: number; out: string }> {
	let out = "";
	const ran = await env.exec(["bash", "-c", script], { cwd, env: vars, timeout, onOutput: (text) => {
		out = (out + text).slice(-8000);
	} }, context);
	if (!ran.ok) return { code: 1, out: `${out}\n${ran.error.message}` };
	return { code: ran.value.exitCode ?? 1, out };
}

/**
 * Runs the ship's checks at the sandbox's HEAD, and each that fails again at `base` in a worktree beside the project,
 * so the agent's tree isn't touched. Throws Stop (`check_failed`) for a failure of the work's; returns what failed on
 * the base too, and whether there was anything to run.
 */
async function checkShip(host: ShipHost, id: number, base: { sha: string; name: string }, say: (line: string) => void): Promise<ShipChecked> {
	const { env, dir } = await host.sandboxes.env(id);
	const config = await sh(env, "git show HEAD:.agents/project.json 2>/dev/null", {}, dir);
	const declared = parseProjectConfig(config.code === 0 ? config.out : undefined).checks;
	const checks = shipChecks(declared, declared.length > 0 ? [] : await host.turnCommands(id), dir);
	if (checks.length === 0) {
		say("no checks to run: the project declares none, and the work's turn ran none that can run again");
		return { unchecked: true };
	}
	const timeout = host.checkTimeout ?? CHECK_TIMEOUT_S;
	say(`running ${checks.length} check${checks.length === 1 ? "" : "s"}${declared.length > 0 ? "" : " from the work's turn"}: ${checks.map((c) => c.name).join(", ")}`);
	const ran = await runChecks(env, dir, checks, context, timeout);
	const failed = checks.filter((_, i) => !ran[i]!.ok);
	if (failed.length === 0) return {};

	say(`${failed.map((c) => c.name).join(", ")} failed; running ${failed.length === 1 ? "it" : "them"} on ${base.name} to see whether the work is why`);
	const wt = `${dir.replace(/\/[^/]+\/?$/, "")}/.aludra-ship-${id}-base`;
	const vars = { DIR: dir, WT: wt, COMMIT: base.sha, INSTALL: "0" };
	const depsChanged = (await sh(env, 'git diff --quiet "$COMMIT" HEAD -- package.json pnpm-lock.yaml package-lock.json yarn.lock', vars, dir)).code !== 0;
	try {
		const made = await sh(env, BASE_WORKTREE, { ...vars, INSTALL: depsChanged ? "1" : "0" }, dir, timeout);
		if (made.code !== 0) {
			const first = failed[0]!;
			throw new Stop("check_failed", `${first.name} fails: ${firstLine(ran[checks.indexOf(first)]!)}; it couldn't be run on ${base.name} to compare (${made.out.trim().split("\n").at(-1) || `exit ${made.code}`}), so nothing was pushed`);
		}
		const onBase = await runChecks(env, wt, failed, context, timeout);
		const baseFailures: BaseFailure[] = [];
		for (const [i, check] of failed.entries()) {
			const atHead = ran[checks.indexOf(check)]!;
			if (onBase[i]!.ok) throw new Stop("check_failed", `${check.name} fails: ${firstLine(atHead)}; it passes on ${base.name}, so nothing was pushed`);
			baseFailures.push({ name: check.name, reason: firstLine(atHead) });
		}
		say(`${baseFailures.map((f) => f.name).join(", ")} fail${baseFailures.length === 1 ? "s" : ""} on ${base.name} too, so not because of the work; shipping anyway`);
		return { baseFailures };
	} finally {
		await sh(env, REMOVE_WORKTREE, vars, "/").catch(() => {});
	}
}

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
	say(`asking session ${id} to rebase onto ${base.remote}/${base.branch} (${sha.slice(0, 12)})`);

	const answered = await options.ask(id, shipPrompt(`${base.remote}/${base.branch}`, sha, options.note));
	if (answered.status === "stopped") throw new Stop("blocked", "it was stopped before it was ready");
	if (answered.status !== "done") throw new Stop("blocked", `its run ended ${answered.status} before it was ready`);
	const verdict = shipVerdict(answered.answer);
	if (!verdict.ready) throw new Stop("blocked", verdict.reason);

	const synced = await host.sandboxes.sync(id, undefined, { force: true });
	if (synced.uncommitted > 0) throw new Stop("check_failed", `the sandbox still has ${synced.uncommitted} uncommitted file${synced.uncommitted === 1 ? "" : "s"}; nothing pushed`);
	const onBase = await git("merge-base", "--is-ancestor", sha, synced.head).then(() => true, () => false);
	if (!onBase) throw new Stop("check_failed", `${synced.branch} isn't on ${base.remote}/${base.branch}; the rebase didn't happen, nothing pushed`);
	const commits = Number(await git("rev-list", "--count", `${sha}..${synced.head}`));
	// Everything is upstream already: nothing to push, and nothing left for this work to do.
	if (commits === 0) {
		say(`nothing to push: ${synced.branch} has no commits beyond ${base.remote}/${base.branch}`);
		// `main` whichever mode was asked: the work is on the base branch, and no branch or pull request was made.
		return { shipped: true, mode: "main", pushed: `${base.remote}/${base.branch}`, head: synced.head, commits: 0 };
	}
	const checked = await checkShip(host, id, { sha, name: base.branch }, say);

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
		return { shipped: true, mode, pushed: `${base.remote}/${base.branch}`, head: synced.head, commits, ...(localResult === undefined ? {} : { local: localResult }), ...checked };
	}

	const branch = `${synced.branch}-${synced.head.slice(0, 7)}`.replace(/^sandbox\//, "sandbox-");
	say(`pushing ${commits} commit${commits === 1 ? "" : "s"} to ${base.remote}/${branch}`);
	await git("push", "--quiet", base.remote, `${synced.head}:refs/heads/${branch}`);
	const pr = await run("gh", ["pr", "create", "--repo", await repoOf(local, base.remote), "--base", base.branch, "--head", branch, "--fill-first"]).then((s) => s.trim().split("\n").at(-1), (error: Error) => {
		say(`couldn't open a pull request: ${error.message.split("\n").at(-1)}`);
		return undefined;
	});
	return { shipped: true, mode, pushed: `${base.remote}/${branch}`, head: synced.head, commits, ...(pr === undefined ? {} : { pr }), ...checked };
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
	/**
	 * Records the ship going on in session `id`'s record, clearing the last stopped one; or, once it's done, clears it and
	 * keeps how it went (shipOutcome), in the same change.
	 */
	mark(id: number, change: { shipping: Shipping } | { done: ShipResult; at: number }): Promise<void>;
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
			await options.mark(id, { done: result, at: Date.now() }).catch((error) => log(`[ship] session ${id}: ${error instanceof Error ? error.message : String(error)}`));
			log(result.shipped ? result.commits === 0 ? `[ship] session ${id}: nothing to push, all on ${result.pushed}` : `[ship] session ${id}: ${result.commits} commit${result.commits === 1 ? "" : "s"} to ${result.pushed}` : `[ship] session ${id} stopped (${result.kind}): ${result.reason}`);
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
			if (record.source === undefined || record.scratch === true) throw new ShipRefused("bad_request", `session ${id} is scratch work with no upstream to ship to; make it a project first`);
			if (going.has(id)) throw new ShipRefused("busy", `session ${id} is already shipping`);
			if ((await options.states()).get(id) !== "idle") throw new ShipRefused("busy", `session ${id} is running; ship once it's done`);
			const shipping: Shipping = { requestId: `ship:${id}:${Date.now().toString(36)}`, mode: request.mode, startedAt: Date.now(), ...(request.note === undefined ? {} : { note: request.note }) };
			await options.mark(id, { shipping });
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
