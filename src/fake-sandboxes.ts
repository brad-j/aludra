// A fake sandbox host: each "sandbox" is a local clone of its project, reached through pi-env's local daemon, so
// tools, sync and ship run for real with no VM. The tests use it, and `aludra serve` does with ALUDRA_SANDBOXES=fake
// (only with ALUDRA_MODEL=faux, src/config.ts), for clients' end-to-end tests.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Connection, localDaemon } from "@earendil-works/pi-env";
import { createSandboxes, type Sandboxes } from "./sandboxes.ts";

export const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: GIT_ENV }).trim();

/**
 * Sandboxes on this machine: each "sandbox" is a clone of its project in `root`, with no remote, as a template makes,
 * reached through pi-env's local daemon, so tools, sync and ship run for real. `create` waits for `release()` while
 * `hold` is set, and fails with `fail`'s message when that's set. Numbers count from 0 like stedding's, past any
 * sandbox already in `root` from an earlier start.
 */
export function fakeSandboxes(root: string) {
	const real = createSandboxes({ ssh: "unused", gateKey: "/dev/null", hostKnownHosts: "/dev/null", sandboxKey: "/dev/null", sandboxHostKey: "ssh-ed25519 AAAA", dataDir: root }, { connect: () => new Connection({ command: [localDaemon()] }) });
	const boxes = join(root, "sandboxes");
	let next = existsSync(boxes) ? Math.max(-1, ...readdirSync(boxes).filter((n) => /^\d+$/.test(n)).map(Number)) + 1 : 0;
	const made: { n: number; dir: string }[] = [];
	const removed: number[] = [];
	/** The size each sandbox was asked for. */
	const sizes: (string | undefined)[] = [];
	const control = {
		hold: false,
		fail: undefined as string | undefined,
		releases: [] as (() => void)[],
		release() {
			for (const release = control.releases.splice(0); release.length > 0;) release.shift()!();
		},
	};
	const sandboxes: Sandboxes = {
		...real,
		configured: () => true,
		dirFor: (project) => join(root, "sandboxes", project.name),
		home: (n) => join(root, "sandboxes", `${n}`, "home"),
		async create(project, _onProgress, onStep, size) {
			sizes.push(size);
			onStep?.("cloning");
			if (control.hold) await new Promise<void>((resolve) => control.releases.push(resolve));
			if (control.fail !== undefined) throw new Error(control.fail);
			onStep?.("starting");
			const n = next++;
			const dir = join(root, "sandboxes", `${n}`, project?.name ?? "bare");
			mkdirSync(dirname(dir), { recursive: true });
			if (project === undefined) mkdirSync(dir, { recursive: true });
			else {
				execFileSync("git", ["clone", "-q", project.dir, dir], { env: GIT_ENV });
				git(dir, "remote", "remove", "origin");
			}
			made.push({ n, dir });
			return { sandbox: n, dir, ...(project === undefined ? {} : { base: git(project.dir, "rev-parse", "HEAD") }) };
		},
		async remove(n) {
			removed.push(n);
		},
		status: async (n) => `sandbox=${n} state=running`,
		states: async () => new Map(made.map((m) => [m.n, "running"])),
	};
	return { sandboxes, control, made, removed, sizes, close: () => real.close() };
}
