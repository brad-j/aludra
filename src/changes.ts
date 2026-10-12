// A session's changes: its project's files now against a snapshot taken when it started.
//
// A snapshot is a git tree of the working tree, written through a temporary index (a copy of the real one, so it's
// quick), so tracked and untracked files count and ignored ones don't, and the repository's index, branches and refs
// are untouched; only objects are added. The changes are the diff from the start's tree to a fresh one, limited to the
// project's directory, so they include the session's commits but not what was already uncommitted when it started.
// The tree is kept by its hash in the session's record; git keeps unreferenced objects for two weeks at least.
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import type { Changes, ChangedFile } from "./api-types.ts";

export type Snapshot = { tree: string; top: string; prefix: string; at: number };

/** Longest diff of one file sent to the app. */
const MAX_PATCH = 400_000;

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
	return new Promise((resolvePromise, reject) => {
		execFile("git", args, { cwd, env: { ...process.env, ...env, GIT_OPTIONAL_LOCKS: "0" }, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (error) reject(new Error(stderr.trim() || error.message));
			else resolvePromise(stdout);
		});
	});
}

/** The working tree under `dir` as a git tree, or why there's none. */
export async function snapshot(dir: string): Promise<Snapshot | { error: string }> {
	let top: string;
	try {
		top = (await git(dir, ["rev-parse", "--show-toplevel"])).trim();
	} catch {
		return { error: "not a git repository" };
	}
	const prefix = relative(top, resolve(dir));
	const scratch = await mkdtemp(join(tmpdir(), "aludra-index-"));
	const index = join(scratch, "index");
	try {
		const real = resolve(top, (await git(top, ["rev-parse", "--git-path", "index"])).trim());
		await copyFile(real, index).catch(() => {});
		await git(top, ["add", "-A", "--", prefix === "" ? "." : prefix], { GIT_INDEX_FILE: index });
		const tree = (await git(top, ["write-tree"], { GIT_INDEX_FILE: index })).trim();
		return { tree, top, prefix, at: Date.now() };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

const pathspec = (base: Snapshot) => (base.prefix === "" ? [] : ["--", base.prefix]);
/** A repository path as the project sees it. */
const local = (base: Snapshot, path: string) => (base.prefix === "" ? path : relative(base.prefix, path));

/** What changed under the project since `base`, the biggest files first. */
export async function changesSince(base: Snapshot): Promise<Changes> {
	const now = await snapshot(join(base.top, base.prefix));
	if ("error" in now) return { available: false, reason: now.error };
	const range = [base.tree, now.tree];
	const [numstat, status] = await Promise.all([
		git(base.top, ["diff", "--numstat", "-z", "-M", ...range, ...pathspec(base)]),
		git(base.top, ["diff", "--name-status", "-z", "-M", ...range, ...pathspec(base)]),
	]);
	const statuses = parseNameStatus(status);
	const files = parseNumstat(numstat).map((file): ChangedFile => {
		const code = statuses.get(file.path) ?? "M";
		return {
			path: local(base, file.path),
			...(file.old === undefined ? {} : { old: local(base, file.old) }),
			add: file.add,
			del: file.del,
			binary: file.binary,
			status: code === "A" ? "added" : code === "D" ? "deleted" : code.startsWith("R") ? "renamed" : "modified",
		};
	});
	files.sort((a, b) => b.add + b.del - (a.add + a.del) || a.path.localeCompare(b.path));
	return {
		available: true,
		since: base.at,
		add: files.reduce((n, f) => n + f.add, 0),
		del: files.reduce((n, f) => n + f.del, 0),
		files,
	};
}

/** The diff of one changed file since `base`, cut if it's very long. */
export async function fileDiff(base: Snapshot, path: string): Promise<string> {
	const now = await snapshot(join(base.top, base.prefix));
	if ("error" in now) throw new Error(now.error);
	const full = join(base.prefix, path);
	const patch = await git(base.top, ["diff", "-M", "--no-color", base.tree, now.tree, "--", full]);
	return patch.length > MAX_PATCH ? `${patch.slice(0, MAX_PATCH)}\n… (${patch.length - MAX_PATCH} more characters)` : patch;
}

/** `git diff --numstat -z`: "add\tdel\tpath\0", or for a rename "add\tdel\t\0old\0new\0"; binary files count "-". */
export function parseNumstat(text: string): { path: string; old?: string; add: number; del: number; binary: boolean }[] {
	const parts = text.split("\0");
	const files = [];
	for (let i = 0; i < parts.length; i++) {
		const head = parts[i]!;
		if (head === "") continue;
		const [add = "", del = "", path = ""] = head.split("\t");
		const binary = add === "-";
		const counts = { add: binary ? 0 : Number(add), del: binary ? 0 : Number(del), binary };
		if (path === "") {
			files.push({ ...counts, old: parts[i + 1]!, path: parts[i + 2]! });
			i += 2;
		} else files.push({ ...counts, path });
	}
	return files;
}

/** `git diff --name-status -z`: "M\0path\0", or "R100\0old\0new\0"; keyed by the new path. */
export function parseNameStatus(text: string): Map<string, string> {
	const parts = text.split("\0");
	const result = new Map<string, string>();
	for (let i = 0; i < parts.length; i++) {
		const code = parts[i]!;
		if (code === "") continue;
		if (code.startsWith("R") || code.startsWith("C")) {
			result.set(parts[i + 2]!, code);
			i += 2;
		} else {
			result.set(parts[i + 1]!, code);
			i += 1;
		}
	}
	return result;
}
