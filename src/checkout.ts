// A project's checkout as the Mac app's project table shows it (amyrlin's protocol section 10 item 19): the branch,
// how many paths are uncommitted, how far it is ahead of and behind its upstream as last fetched, and whether a sandbox
// can start from it. Read with one `git status`, which never fetches and, with --no-optional-locks, never writes the
// index, so reading every project every few seconds leaves the checkouts as they were.
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";

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
};

function git(dir: string, args: readonly string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("git", ["--no-optional-locks", "-C", dir, ...args], { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
	});
}

/** `git status --porcelain=v2 --branch` read into a checkout, without the sandbox part. */
export function parseStatus(text: string): Omit<Checkout, "sandboxes"> & { commits: boolean } {
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
	const none = (reason: string): Checkout => ({ dirty: 0, ahead: 0, behind: 0, sandboxes: { reason } });
	let top: string;
	try {
		top = (await git(dir, ["rev-parse", "--show-toplevel"])).trim();
	} catch {
		return none("it isn't in git");
	}
	let status;
	try {
		status = parseStatus(await git(dir, ["status", "--porcelain=v2", "--branch"]));
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
	return { ...checkout, sandboxes: reason === undefined ? true : { reason } };
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
