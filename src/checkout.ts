// A project's checkout as the Mac app's project table shows it (amyrlin's protocol section 10 item 19): the branch,
// how many paths are uncommitted, how far it is ahead of and behind its upstream as last fetched, and whether a sandbox
// can start from it. Read with one `git status`, which never fetches and, with --no-optional-locks, never writes the
// index, so reading every project every few seconds leaves the checkouts as they were. Its last commit also says what
// a sandbox task could check there: the checks its `.agents/project.json` declares, and whether it has code to check.
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { parseProjectConfig } from "./results.ts";

export type Checkout = {
	/** The checked-out branch; absent when HEAD is detached. */
	branch?: string;
	/** Paths with uncommitted changes, untracked ones included. */
	dirty: number;
	/** Commits ahead of and behind `upstream`, as last fetched; 0 without one. */
	ahead: number;
	behind: number;
	upstream?: string;
	/** Whether a sandbox can start from it, or why not. */
	sandboxes: true | { reason: string };
	/** Checks the last commit's `.agents/project.json` declares, which a sandbox (made from that commit) runs. */
	checks: number;
	/** Whether the last commit has something to check: a package manifest, Makefile or the like in the project's folder. */
	code: boolean;
};

/** Files at a project's top that mean it has code with tests, a build or a type check to find. */
const MANIFESTS = new Set(["package.json", "deno.json", "deno.jsonc", "Makefile", "makefile", "GNUmakefile", "justfile", "Justfile", "Cargo.toml", "go.mod", "pyproject.toml", "setup.py", "requirements.txt", "Package.swift", "project.yml", "Gemfile", "mix.exs", "pom.xml", "build.gradle", "build.gradle.kts", "CMakeLists.txt", "meson.build", "composer.json", "flake.nix", "Taskfile.yml"]);

/** What a commit says about checks, by directory and commit, since a commit never changes. */
const declared = new Map<string, { checks: number; code: boolean }>();

/** The checks commit `oid` of `dir` declares, and whether it has code to check. */
async function readDeclared(dir: string, oid: string): Promise<{ checks: number; code: boolean }> {
	const key = `${dir}\0${oid}`;
	const known = declared.get(key);
	if (known !== undefined) return known;
	// `<commit>:./` is the project's folder in it, which is the repository's top unless the project is inside a bigger one.
	const top = (await git(dir, ["ls-tree", "--name-only", `${oid}:./`]).catch(() => "")).split("\n").filter((name) => name !== "");
	const code = top.some((name) => MANIFESTS.has(name) || name.endsWith(".xcodeproj") || name.endsWith(".csproj") || name.endsWith(".sln"));
	const text = top.includes(".agents") ? await git(dir, ["show", `${oid}:./.agents/project.json`]).catch(() => undefined) : undefined;
	const found = { checks: parseProjectConfig(text).checks.length, code };
	if (declared.size > 500) declared.clear();
	declared.set(key, found);
	return found;
}

function git(dir: string, args: readonly string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("git", ["--no-optional-locks", "-C", dir, ...args], { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
	});
}

/** `git status --porcelain=v2 --branch` read into a checkout, without the sandbox part or what its commit checks. */
export function parseStatus(text: string): Omit<Checkout, "sandboxes" | "checks" | "code"> & { commits: boolean } {
	let branch: string | undefined;
	let upstream: string | undefined;
	let ahead = 0;
	let behind = 0;
	let commits = true;
	let dirty = 0;
	for (const line of text.split("\n")) {
		if (line.startsWith("# branch.oid ")) commits = line.slice(13) !== "(initial)";
		else if (line.startsWith("# branch.head ")) branch = line.slice(14) === "(detached)" ? undefined : line.slice(14);
		else if (line.startsWith("# branch.upstream ")) upstream = line.slice(18);
		else if (line.startsWith("# branch.ab ")) {
			const m = /^\+(\d+) -(\d+)$/.exec(line.slice(12));
			if (m !== null) [ahead, behind] = [Number(m[1]), Number(m[2])];
		} else if (line !== "" && !line.startsWith("#")) dirty += 1;
	}
	return { ...(branch === undefined ? {} : { branch }), dirty, ahead, behind, ...(upstream === undefined ? {} : { upstream }), commits };
}

/**
 * Project `dir`'s checkout, or `sandboxes: { reason }` alone when it isn't one. `sandboxHost` says whether the host has a
 * sandbox host at all.
 */
export async function readCheckout(dir: string, sandboxHost: boolean): Promise<Checkout> {
	const none = (reason: string): Checkout => ({ dirty: 0, ahead: 0, behind: 0, sandboxes: { reason }, checks: 0, code: false });
	let top: string;
	try {
		top = (await git(dir, ["rev-parse", "--show-toplevel"])).trim();
	} catch {
		return none("it isn't in git");
	}
	let status;
	let oid: string | undefined;
	try {
		const text = await git(dir, ["status", "--porcelain=v2", "--branch"]);
		status = parseStatus(text);
		oid = /^# branch\.oid ([0-9a-f]+)$/m.exec(text)?.[1];
	} catch (error) {
		return none(`git status failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
	}
	const { commits, ...checkout } = status;
	const same = (a: string, b: string) => {
		try {
			return realpathSync(a) === realpathSync(b);
		} catch {
			return a === b;
		}
	};
	// A template is a clone of the repository's HEAD, so a project inside a bigger repository would get all of it.
	const reason = !sandboxHost ? "this host has no sandbox host"
		: !commits ? "it has no commits yet"
		: !same(top, dir) ? `it's inside the repository at ${top}`
		: undefined;
	const found = oid === undefined ? { checks: 0, code: false } : await readDeclared(dir, oid);
	return { ...checkout, sandboxes: reason === undefined ? true : { reason }, ...found };
}

/**
 * Every project's checkout, read again every `everyMs` while anyone listens, telling listeners the whole list when
 * any changed. `projects` is read each time, since the workspaces can change while the host runs.
 */
export function watchCheckouts(projects: () => readonly { dir: string }[], sandboxHost: () => boolean, everyMs = 5_000) {
	let latest = new Map<string, Checkout>();
	const listeners = new Set<(checkouts: Map<string, Checkout>) => void>();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let reading: Promise<Map<string, Checkout>> | undefined;

	function read(): Promise<Map<string, Checkout>> {
		reading ??= (async () => {
			const dirs = projects().map((p) => p.dir);
			const found = new Map<string, Checkout>();
			// A few at a time: the projects are on one disk.
			for (let i = 0; i < dirs.length; i += 8) {
				const batch = dirs.slice(i, i + 8);
				const read = await Promise.all(batch.map((dir) => readCheckout(dir, sandboxHost())));
				batch.forEach((dir, j) => found.set(dir, read[j]!));
			}
			return found;
		})().finally(() => (reading = undefined));
		return reading;
	}

	async function tick() {
		timer = undefined;
		try {
			const next = await read();
			const changed = JSON.stringify([...next]) !== JSON.stringify([...latest]);
			latest = next;
			if (changed) for (const listener of listeners) listener(latest);
		} catch (error) {
			console.error(`[checkouts] ${error instanceof Error ? error.message : String(error)}`);
		}
		if (listeners.size > 0) {
			timer = setTimeout(() => void tick(), everyMs);
			timer.unref();
		}
	}

	return {
		/** Every project's checkout now, by directory. */
		async current(): Promise<Map<string, Checkout>> {
			latest = await read();
			return latest;
		},
		/** Hears the whole list whenever a checkout changes, checked every `everyMs` while anyone listens. */
		onChange(listener: (checkouts: Map<string, Checkout>) => void): () => void {
			listeners.add(listener);
			if (timer === undefined && listeners.size === 1) {
				timer = setTimeout(() => void tick(), everyMs);
				timer.unref();
			}
			return () => {
				listeners.delete(listener);
				if (listeners.size > 0) return;
				clearTimeout(timer);
				timer = undefined;
			};
		},
		close() {
			clearTimeout(timer);
			listeners.clear();
		},
	};
}
