// A project's checkout in detail, for a client's "N uncommitted" popover (plan item project-status): which files are
// uncommitted, staged or not, with their line counts, and which commits are ahead of and behind the upstream; and one
// file's diff. Read-only, like readCheckout (src/checkout.ts): `git --no-optional-locks` never writes the index, and
// nothing fetches, so `behind` is as of the last fetch.
//
// Paths are as the project sees them, relative to its directory, which may be inside a bigger repository; only that
// directory's files are listed.
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

export type FileState = "untracked" | "modified" | "added" | "deleted" | "renamed" | "conflicted";

export type StatusFile = { path: string; old?: string; state: FileState; staged: boolean; add: number; del: number; binary: boolean };

export type Commit = { sha: string; subject: string };

export type ProjectStatus = {
	branch?: string;
	upstream?: string;
	ahead: number;
	behind: number;
	files: StatusFile[];
	commits: { ahead: Commit[]; behind: Commit[] };
	/** More files than MAX_FILES are uncommitted; `files` has the first of them. */
	truncated?: true;
};

export type ProjectDiff = { path: string; patch: string } | { path: string; binary: true } | { path: string; tooLarge: true };

export const MAX_FILES = 500;
export const MAX_COMMITS = 20;
/** Longest patch sent; a longer one is `tooLarge`. */
export const MAX_PATCH = 400_000;

/** Not a git checkout, or a path the project doesn't have changed: the client's mistake, said in words. */
export class StatusRefused extends Error {
	readonly code: "not_found" | "bad_request";
	constructor(code: "not_found" | "bad_request", message: string) {
		super(message);
		this.code = code;
	}
}

function git(cwd: string, args: readonly string[], okCodes: readonly number[] = [0]): Promise<string> {
	return new Promise((resolvePromise, reject) => {
		execFile("git", ["--no-optional-locks", ...args], { cwd, timeout: 15_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }, (error, stdout, stderr) => {
			const code = error === null ? 0 : typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : -1;
			if (okCodes.includes(code)) resolvePromise(stdout);
			else reject(new Error(stderr.trim() || (error?.message ?? "git failed")));
		});
	});
}

/** The repository's top and the project's directory inside it ("" at the top). */
async function placeOf(dir: string): Promise<{ top: string; prefix: string }> {
	let top: string;
	try {
		top = (await git(dir, ["rev-parse", "--show-toplevel"])).trim();
	} catch {
		throw new StatusRefused("bad_request", `${dir} isn't in git`);
	}
	return { top, prefix: relative(top, await realpath(resolve(dir))) };
}

const STATE: Record<string, FileState> = { M: "modified", T: "modified", A: "added", D: "deleted", R: "renamed", C: "added" };

/** `git status --porcelain=v2 -z --branch --untracked-files=all` as files and branch facts; paths are the repository's. */
export function parseStatusZ(text: string): { branch?: string; upstream?: string; ahead: number; behind: number; files: { path: string; old?: string; state: FileState; staged: boolean }[] } {
	const out: ReturnType<typeof parseStatusZ> = { ahead: 0, behind: 0, files: [] };
	const fields = text.split("\0");
	for (let i = 0; i < fields.length; i++) {
		const entry = fields[i]!;
		if (entry === "") continue;
		if (entry.startsWith("# branch.head ")) {
			const head = entry.slice(14);
			if (head !== "(detached)") out.branch = head;
		} else if (entry.startsWith("# branch.upstream ")) out.upstream = entry.slice(18);
		else if (entry.startsWith("# branch.ab ")) {
			const m = /^\+(\d+) -(\d+)$/.exec(entry.slice(12));
			if (m !== null) [out.ahead, out.behind] = [Number(m[1]), Number(m[2])];
		} else if (entry.startsWith("? ")) out.files.push({ path: entry.slice(2), state: "untracked", staged: false });
		else if (entry.startsWith("u ")) out.files.push({ path: entry.split(" ").slice(10).join(" "), state: "conflicted", staged: false });
		else if (entry.startsWith("1 ") || entry.startsWith("2 ")) {
			const parts = entry.split(" ");
			const xy = parts[1]!;
			const renamed = entry.startsWith("2 ");
			const path = parts.slice(renamed ? 9 : 8).join(" ");
			// A rename's old path is the next NUL-separated field.
			const old = renamed ? fields[++i] : undefined;
			const code = xy[0] !== "." ? xy[0]! : xy[1]!;
			out.files.push({ path, ...(old === undefined ? {} : { old }), state: renamed ? "renamed" : STATE[code] ?? "modified", staged: xy[0] !== "." });
		}
	}
	return out;
}

/** `git diff --numstat -z` lines: added and deleted counts by path (a rename's new path), binary files marked. */
function parseNumstatZ(text: string): Map<string, { add: number; del: number; binary: boolean }> {
	const found = new Map<string, { add: number; del: number; binary: boolean }>();
	const fields = text.split("\0");
	for (let i = 0; i < fields.length; i++) {
		const head = fields[i]!;
		if (head === "") continue;
		const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(head);
		if (m === null) continue;
		let path = m[3]!;
		// A rename has an empty path here, then the old and new paths as their own fields.
		if (path === "") {
			i += 2;
			path = fields[i] ?? "";
		}
		const binary = m[1] === "-";
		found.set(path, { add: binary ? 0 : Number(m[1]), del: binary ? 0 : Number(m[2]), binary });
	}
	return found;
}

/** Lines in an untracked file, or binary when it has a NUL in its first 8 KB, read without git. */
async function untrackedCount(file: string): Promise<{ add: number; binary: boolean }> {
	const { open } = await import("node:fs/promises");
	const handle = await open(file, "r").catch(() => undefined);
	if (handle === undefined) return { add: 0, binary: false };
	try {
		const size = (await handle.stat()).size;
		if (size > 8 * MAX_PATCH) return { add: 0, binary: false };
		const data = Buffer.alloc(size);
		await handle.read(data, 0, size, 0);
		if (data.subarray(0, 8192).includes(0)) return { add: 0, binary: true };
		const text = data.toString("utf8");
		return { add: text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0), binary: false };
	} finally {
		await handle.close();
	}
}

/** The commits `range` names, newest first, at most MAX_COMMITS. */
async function commitsIn(top: string, range: string): Promise<Commit[]> {
	const text = await git(top, ["log", "--no-color", `--max-count=${MAX_COMMITS}`, "--format=%H%x00%s", range, "--"]).catch(() => "");
	return text.split("\n").filter((line) => line.includes("\0")).map((line) => {
		const [sha, subject] = line.split("\0") as [string, string];
		return { sha, subject };
	});
}

/** Project `dir`'s uncommitted files with their counts, and the commits ahead of and behind its upstream. */
export async function projectStatus(dir: string): Promise<ProjectStatus> {
	const { top, prefix } = await placeOf(dir);
	const within = prefix === "" ? [] : ["--", prefix];
	const status = parseStatusZ(await git(top, ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all", ...within]));
	const hasHead = await git(top, ["rev-parse", "--verify", "--quiet", "HEAD"]).then(() => true, () => false);
	// Against HEAD, staged and unstaged together; with no commit yet, against the empty tree.
	const base = hasHead ? "HEAD" : (await git(top, ["hash-object", "-t", "tree", "/dev/null"])).trim();
	const counts = parseNumstatZ(await git(top, ["diff", "--numstat", "-z", "-M", base, ...(within.length === 0 ? ["--"] : within)]).catch(() => ""));
	const local = (path: string) => (prefix === "" ? path : relative(prefix, path));
	const listed = status.files.slice(0, MAX_FILES);
	const files: StatusFile[] = [];
	for (const file of listed) {
		const count = file.state === "untracked" ? { ...(await untrackedCount(join(top, file.path))), del: 0 } : counts.get(file.path) ?? { add: 0, del: 0, binary: false };
		files.push({ path: local(file.path), ...(file.old === undefined ? {} : { old: local(file.old) }), state: file.state, staged: file.staged, add: count.add, del: count.del, binary: count.binary });
	}
	const upstream = status.upstream;
	const commits = upstream === undefined || !hasHead ? { ahead: [], behind: [] } : { ahead: await commitsIn(top, `${upstream}..HEAD`), behind: await commitsIn(top, `HEAD..${upstream}`) };
	return {
		...(status.branch === undefined ? {} : { branch: status.branch }),
		...(upstream === undefined ? {} : { upstream }),
		ahead: status.ahead,
		behind: status.behind,
		files,
		commits,
		...(status.files.length > MAX_FILES ? { truncated: true as const } : {}),
	};
}

/**
 * The diff of one of project `dir`'s changed files against HEAD, staged and unstaged together; an untracked file as all
 * added. `path` is relative to the project; one outside it is `bad_request`, one with no change `not_found`.
 */
export async function projectDiff(dir: string, path: string): Promise<ProjectDiff> {
	if (path === "" || isAbsolute(path) || normalize(path).split(sep).includes("..")) throw new StatusRefused("bad_request", `${path} isn't a path inside the project`);
	const { top, prefix } = await placeOf(dir);
	const full = prefix === "" ? normalize(path) : join(prefix, normalize(path));
	const status = parseStatusZ(await git(top, ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--", full]));
	const file = status.files.find((f) => f.path === full || f.old === full);
	if (file === undefined) throw new StatusRefused("not_found", `${path} has no uncommitted change`);
	let patch: string;
	if (file.state === "untracked") {
		// --no-index exits 1 when the files differ, which they always do here.
		patch = await git(top, ["diff", "--no-color", "--no-index", "--", "/dev/null", file.path], [0, 1]);
	} else {
		const hasHead = await git(top, ["rev-parse", "--verify", "--quiet", "HEAD"]).then(() => true, () => false);
		const base = hasHead ? "HEAD" : (await git(top, ["hash-object", "-t", "tree", "/dev/null"])).trim();
		patch = await git(top, ["diff", "--no-color", "-M", base, "--", ...(file.old === undefined ? [] : [file.old]), file.path]);
	}
	if (/^Binary files .* differ$/m.test(patch) || patch.includes("GIT binary patch")) return { path, binary: true };
	if (patch.length > MAX_PATCH) return { path, tooLarge: true };
	return { path, patch };
}
