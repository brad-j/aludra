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
import type { Host } from "./host.ts";
import { fastForward, type MergeResult, run } from "./sandboxes.ts";

export type ShipMode = "main" | "branch";

export type ShipResult =
	| { shipped: true; mode: ShipMode; pushed: string; head: string; commits: number; pr?: string; local?: MergeResult }
	| { shipped: false; reason: string };

/** The message that asks the session to get its work ready to land on `base`. */
export function shipPrompt(base: string, sha: string): string {
	return [
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
	/** Each line of progress, for the CLI. */
	onProgress?: (line: string) => void;
	/** Sends the prompt to the session and resolves with its answer's text once the run ends; the host's by default. */
	ask?: (id: number, prompt: string) => Promise<{ status: string; answer?: string }>;
};

export async function ship(host: Pick<Host, "sessions" | "sandboxes">, id: number, options: ShipOptions & { ask: NonNullable<ShipOptions["ask"]> }): Promise<ShipResult> {
	const say = options.onProgress ?? (() => {});
	const mode = options.mode ?? "main";
	const record = await host.sessions.get(id);
	if (record === undefined) return { shipped: false, reason: `no session ${id}` };
	if (record.sandbox === undefined || record.source === undefined) return { shipped: false, reason: `session ${id} isn't a sandbox session of a project` };
	if (record.sandboxRemoved === true) return { shipped: false, reason: `session ${id}'s sandbox was deleted when it was archived` };
	const local = record.source;
	const git = (...args: string[]) => run("git", ["-C", local, ...args]).then((s) => s.trim());

	const base = await shipBase(local);
	say(`fetching ${base.remote}/${base.branch}`);
	await git("fetch", "--quiet", base.remote, base.branch);
	const sha = await host.sandboxes.receiveBase(id, base.ref);
	say(`asking session ${id} to rebase onto ${base.remote}/${base.branch} (${sha.slice(0, 12)}) and run the tests`);

	const answered = await options.ask(id, shipPrompt(`${base.remote}/${base.branch}`, sha));
	if (answered.status !== "done") return { shipped: false, reason: `the session's run ended ${answered.status}` };
	const verdict = shipVerdict(answered.answer);
	if (!verdict.ready) return { shipped: false, reason: `not ready: ${verdict.reason}` };

	const synced = await host.sandboxes.sync(id, undefined, { force: true });
	if (synced.uncommitted > 0) return { shipped: false, reason: `the sandbox still has ${synced.uncommitted} uncommitted file${synced.uncommitted === 1 ? "" : "s"}; nothing pushed` };
	const onBase = await git("merge-base", "--is-ancestor", sha, synced.head).then(() => true, () => false);
	if (!onBase) return { shipped: false, reason: `${synced.branch} isn't on ${base.remote}/${base.branch}; the rebase didn't happen, nothing pushed` };
	const commits = Number(await git("rev-list", "--count", `${sha}..${synced.head}`));
	if (commits === 0) return { shipped: false, reason: `nothing to ship: ${synced.branch} has no commits beyond ${base.remote}/${base.branch}` };

	if (mode === "main") {
		say(`pushing ${commits} commit${commits === 1 ? "" : "s"} to ${base.remote}/${base.branch}`);
		// Without force: if the base moved since the fetch, this fails and the user ships again.
		await git("push", "--quiet", base.remote, `${synced.head}:refs/heads/${base.branch}`).catch((error: Error) => {
			throw new Error(/rejected|fetch first|non-fast-forward/.test(error.message) ? `${base.remote}/${base.branch} moved while shipping; ship again to rebase onto it` : error.message);
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
