// Sandboxes (spike): sessions whose tools run in a stedding sandbox, a Firecracker microVM on another machine, through pi-env's
// daemon over SSH. The agent loop, the transcript and the model stay here.
//
// Each sandbox session gets its own sandbox, made from its project's template: the base image with the project cloned and its
// dependencies installed, saved once and reused for 24 hours or until the project's commit changes. A new commit's template
// is made from the project's previous one when it can, so the install and any build redo only what changed. Everything on the
// sandbox host goes through one restricted key whose authorized_keys line forces `stedding gate`, which allows only
// `new`, `save`, `connect`, `rm`, `status` and `templates` with plain arguments. The sandbox's own SSH runs through
// `connect N`, which resumes a paused sandbox before relaying, so a tool call wakes it.
//
// A connection with nothing in flight for `idleMs` is closed, so the host's reaper can pause the sandbox. Closing ends the
// pi-env daemon, which kills the process groups it started; a process started with setsid survives, and pauses and
// resumes with the sandbox.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as BACKGROUND } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { type Connection, RemoteExecutionEnv, type SshConnectOptions, sshConnection } from "@earendil-works/pi-env";

/** A sandbox host: where stedding runs, reached with a key restricted to `stedding gate`. */
export type SandboxHost = {
	/** SSH destination of the sandbox host, e.g. `ubuntu@matrim`. */
	ssh: string;
	/** The restricted key for the sandbox host. */
	gateKey: string;
	/** Known hosts for the sandbox host, checked strictly. */
	hostKnownHosts: string;
	/** The key sandboxes accept for `user` (stedding's own), and the sandboxes' host key, as one known-hosts line's key part. */
	sandboxKey: string;
	sandboxHostKey: string;
	/** Where this machine keeps sandboxes' known-hosts files. */
	dataDir: string;
};

/** What a project's template is made from. */
export type ProjectSource = { name: string; dir: string };

/** How big a sandbox is: small is stedding's default. stedding takes up to 8 CPUs and 32 GB a sandbox. */
export const SIZES = { small: { cpus: 2, mem: 4096 }, medium: { cpus: 4, mem: 8192 }, large: { cpus: 8, mem: 16384 } } as const;
export type SandboxSize = keyof typeof SIZES;
export const isSize = (value: unknown): value is SandboxSize => typeof value === "string" && Object.hasOwn(SIZES, value);
/** stedding's words for a sandbox of `size`. */
const sizeWords = (size: SandboxSize = "small") => ["--mem", String(SIZES[size].mem), "--cpus", String(SIZES[size].cpus)];

type Live = { connection: Connection; inFlight: number; timer?: NodeJS.Timeout };

const TEMPLATE_MAX_AGE_S = 24 * 3600;
/** Templates are made at the largest size: a saved template keeps only its disk, so the CPUs and memory cost nothing after. */
const TEMPLATE_SIZE: SandboxSize = "large";
/** Longest a project's `.agents/resume` may run after its sandbox wakes. */
export const RESUME_S = 60;

export function run(cmd: string, args: readonly string[], input?: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (error) reject(new Error(`${cmd} ${args.at(-1)}: ${stderr.trim() || error.message}`));
			else resolve(stdout);
		});
		if (input !== undefined) child.stdin?.end(input);
	});
}

/** What making a session's sandbox is doing: waiting for a template another session is making, or a stage of its own. */
export type SandboxStep = "waiting" | "cloning" | "installing" | "saving" | "starting";

/** Printed by the template script before the install, so the step can follow it. */
const STEP_MARK = "@@aludra-step ";

/** A project's directory in its sandboxes. */
export function sandboxDir(project: Pick<ProjectSource, "name">): string {
	return `/home/user/work/${project.name}`;
}

/** A template name for `project` at `commit`: safe for stedding, stable while the commit is. */
export function templateName(project: string, commit: string): string {
	return `${project.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[^A-Za-z0-9]+/, "p")}-${commit.slice(0, 12)}`;
}

/**
 * The template to make `name` from: `project`'s newest other template under a day old, from `stedding templates`'s
 * output (newest first), or undefined to start from the base image.
 */
export function priorTemplate(project: string, name: string, listing: string): string | undefined {
	const prefix = templateName(project, "");
	for (const line of listing.split("\n")) {
		const m = /^template=(\S+) age=(\d+)/.exec(line);
		if (m === null || m[1] === name || Number(m[2]) >= TEMPLATE_MAX_AGE_S) continue;
		if (m[1]!.startsWith(prefix) && /^[0-9a-f]{12}$/.test(m[1]!.slice(prefix.length))) return m[1];
	}
	return undefined;
}

/**
 * The templates to drop once `keep` is saved for `project`, from `stedding templates`'s output: the project's others,
 * since only its newest is used (for its commit, and to make the next commit's from), and any project's a day old,
 * which nothing uses again.
 */
export function staleTemplates(project: string, keep: string, listing: string): string[] {
	const prefix = templateName(project, "");
	const stale: string[] = [];
	for (const line of listing.split("\n")) {
		const m = /^template=(\S+) age=(\d+)/.exec(line);
		if (m === null || m[1] === keep) continue;
		const ours = m[1]!.startsWith(prefix) && /^[0-9a-f]{12}$/.test(m[1]!.slice(prefix.length));
		if (ours || Number(m[2]) >= TEMPLATE_MAX_AGE_S) stale.push(m[1]!);
	}
	return stale;
}

/** Holds when the chain of templates a template was made in began from the base image, in seconds since the epoch. */
const SINCE = "~/.aludra-template-since";

/**
 * The script that makes a template in a sandbox whose home holds `project.bundle` of the project's HEAD. From the base
 * image (`from` false) it clones the bundle into `dir`; from the project's previous template it fetches the bundle and
 * checks it out over the previous commit, keeping what the setup made (dependencies, build output). It prints
 * `STEP_MARK fresh` and stops, for a start from the base image instead, when the chain began a day ago or more or the
 * new commit changes `.agents/setup`. Then it installs: `.agents/setup` if the project has one, else with the lockfile's
 * package manager.
 */
export function templateScript(o: { dir: string; branch: string; from: boolean; userName: string; userEmail: string }): string {
	const dir = shellQuote(o.dir);
	const start = o.from ? [
		`cd ${dir}`,
		"git fetch -q ~/project.bundle HEAD && rm ~/project.bundle",
		`since=$(cat ${SINCE} 2>/dev/null || echo 0)`,
		`if (( $(date +%s) - since >= ${TEMPLATE_MAX_AGE_S} )) || ! git diff --quiet HEAD FETCH_HEAD -- .agents/setup; then echo ${STEP_MARK}fresh; exit 0; fi`,
		o.branch === "HEAD" ? "git checkout -q -f --detach FETCH_HEAD" : `git checkout -q -f -B ${shellQuote(o.branch)} FETCH_HEAD`,
	] : [
		`git clone -q --branch ${o.branch === "HEAD" ? "HEAD" : shellQuote(o.branch)} ~/project.bundle ${dir} 2>/dev/null || git clone -q ~/project.bundle ${dir}`,
		`cd ${dir} && git remote remove origin && rm ~/project.bundle`,
		`date +%s > ${SINCE}`,
		// Tools that reserve a large address range up front (oxlint's allocator pool) fail under the kernel's overcommit
		// heuristic in a VM with no swap. A throwaway sandbox has nothing the heuristic protects; set at every boot.
		"echo vm.overcommit_memory=1 | sudo tee /etc/sysctl.d/60-aludra.conf >/dev/null && sudo sysctl -q vm.overcommit_memory=1",
	];
	return [
		"set -euo pipefail",
		...start,
		...(o.userName === "" ? [] : [`git config --global user.name ${shellQuote(o.userName)}`]),
		...(o.userEmail === "" ? [] : [`git config --global user.email ${shellQuote(o.userEmail)}`]),
		`echo ${STEP_MARK}installing`,
		"if [ -x .agents/setup ]; then .agents/setup",
		"elif [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile",
		"elif [ -f package-lock.json ]; then npm ci",
		"elif [ -f package.json ]; then pnpm install",
		"elif [ -f Cargo.toml ]; then command -v cargo >/dev/null && cargo fetch || echo 'no cargo in the image; .agents/setup can install it'",
		"elif [ -f requirements.txt ]; then python3 -m venv .venv && .venv/bin/pip install -q -r requirements.txt",
		"fi",
		"sync",
	].join("\n");
}

export function createSandboxes(host: SandboxHost | undefined, options: {
	idleMs?: number;
	connect?: (sandbox: number, target: SshConnectOptions) => Connection;
	/** Sandbox `n`'s state on its host before a connection opens; stedding's status by default. Tests replace it. */
	state?: (n: number) => Promise<string | undefined>;
	log?: (line: string) => void;
} = {}) {
	const idleMs = options.idleMs ?? 60_000;
	const live = new Map<number, Live>();
	const making = new Map<string, Promise<string>>();
	/** Each sandbox's project directory, where `.agents/resume` runs after it wakes: the first directory an env names. */
	const projectDirs = new Map<number, string>();
	const log = options.log ?? ((line: string) => console.error(line));
	// A test's own connections have no sandbox host to ask, unless it says what the state is.
	const stateOf = options.state ?? (options.connect !== undefined ? async () => undefined : async (n: number) => /state=(\w+)/.exec(await stedding("status", String(n)))?.[1]);

	function need(): SandboxHost {
		if (host === undefined) throw new Error("no sandbox host in the settings");
		return host;
	}

	/** Runs a stedding command on the sandbox host through the gate. */
	function stedding(...words: string[]): Promise<string> {
		const h = need();
		return run("ssh", ["-T", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-i", h.gateKey, "-o", `UserKnownHostsFile=${h.hostKnownHosts}`, "-o", "StrictHostKeyChecking=yes", h.ssh, words.join(" ")]);
	}

	/** The SSH target for sandbox `n`: its own known-hosts file holding the image's host key, reached through `connect`. */
	async function target(n: number): Promise<SshConnectOptions> {
		const h = need();
		const alias = `stedding-sandbox-${n}`;
		const knownHosts = join(h.dataDir, `sandbox-${n}.known_hosts`);
		await writeFile(knownHosts, `${alias} ${h.sandboxHostKey}\n`, { mode: 0o600 });
		const config = join(h.dataDir, `sandbox-${n}.ssh_config`);
		const proxy = ["ssh", "-T", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-i", h.gateKey, "-o", `UserKnownHostsFile=${h.hostKnownHosts}`, "-o", "StrictHostKeyChecking=yes", h.ssh, "connect", String(n)].join(" ");
		await writeFile(config, `Host ${alias}\n\tHostName ${alias}\n\tUser user\n\tProxyCommand ${proxy}\n`, { mode: 0o600 });
		return { host: alias, configFile: config, identityFile: h.sandboxKey, knownHostsFile: knownHosts, hostKeyAlias: alias };
	}

	function close(n: number) {
		const found = live.get(n);
		if (found === undefined) return;
		clearTimeout(found.timer);
		live.delete(n);
		found.connection.close();
	}

	function idleCheck(n: number, entry: Live) {
		clearTimeout(entry.timer);
		if (entry.inFlight > 0) return;
		entry.timer = setTimeout(() => {
			if (live.get(n) === entry && entry.inFlight === 0) close(n);
		}, idleMs);
		entry.timer.unref();
	}

	/**
	 * Runs the project's `.agents/resume` in sandbox `n` after it woke, over the new connection `inner` (not the counted
	 * one, which is still opening), as `user` from `dir`, for at most RESUME_S. Anything that goes wrong is logged; the call
	 * that woke the sandbox goes on either way.
	 */
	async function resume(n: number, inner: Connection, dir: string): Promise<void> {
		const env = new RemoteExecutionEnv({ connection: inner, id: `stedding:${n}:resume`, cwd: dir });
		let out = "";
		const script = `[ -x .agents/resume ] || exit 0; exec timeout ${RESUME_S} ./.agents/resume`;
		const ran = await env.exec(["bash", "-lc", script], { cwd: dir, timeout: RESUME_S + 5, onOutput: (text) => (out = (out + text).slice(-2000)) }, BACKGROUND).catch((error: Error) => ({ ok: false as const, error }));
		if (!ran.ok) log(`[sandbox ${n}] .agents/resume after waking: ${ran.error.message}`);
		else if (ran.value.exitCode !== 0) log(`[sandbox ${n}] .agents/resume after waking exited ${ran.value.exitCode}${ran.value.exitCode === 124 ? ` (stopped after ${RESUME_S} s)` : ""}: ${out.trim().split("\n").slice(-3).join(" / ")}`);
	}

	/** The connection to sandbox `n`, made on first use; the SSH target is written then. */
	function connection(n: number): Connection {
		const found = live.get(n);
		if (found !== undefined) return found.connection;
		const connect = options.connect;
		let inner: Connection | undefined;
		let starting: Promise<Connection> | undefined;
		const start = () => (starting ??= (async () => {
			// A connection opens after the last one went idle, so this is when a paused sandbox wakes; ask first, since
			// connecting resumes it.
			const dir = projectDirs.get(n);
			const paused = dir !== undefined && (await stateOf(n).catch(() => undefined)) === "paused";
			const t = await target(n);
			inner = connect !== undefined ? connect(n, t) : sshConnection({ ...t, onLog: (text) => console.error(`[sandbox ${n}] ${text.trimEnd()}`) }).connection;
			if (paused) await resume(n, inner, dir);
			return inner;
		})());
		// A Connection whose requests wait for the target to be written; counts requests so it closes only between them.
		const entry: Live = { connection: undefined as unknown as Connection, inFlight: 0 };
		const proxy = {
			async info() { return (await start()).info(); },
			async session() { return (await start()).session(); },
			async request(...args: Parameters<Connection["request"]>) {
				entry.inFlight++;
				clearTimeout(entry.timer);
				try {
					return await (await start()).request(...args);
				} finally {
					entry.inFlight--;
					idleCheck(n, entry);
				}
			},
			kill(id: number, session: number) { inner?.kill(id, session); },
			close() { inner?.close(); },
		};
		// SAFETY: RemoteExecutionEnv only calls these five methods of its Connection.
		entry.connection = proxy as unknown as Connection;
		live.set(n, entry);
		return entry.connection;
	}

	/**
	 * The template for `project`'s current commit, made if missing or older than a day: from the project's previous
	 * template when there's one under a day old, else (or when that fails) from the base image, by `templateScript`, and
	 * saved; then the templates it makes stale are dropped. Concurrent calls for one template share the work.
	 */
	async function template(project: ProjectSource, onProgress?: (line: string) => void, onStep?: (step: SandboxStep) => void): Promise<{ name: string; commit: string }> {
		const commit = (await run("git", ["-C", project.dir, "rev-parse", "HEAD"])).trim();
		const name = templateName(project.name, commit);
		const listing = await stedding("templates");
		const existing = listing.split("\n").map((l) => /^template=(\S+) age=(\d+)/.exec(l)).find((m) => m?.[1] === name);
		if (existing && Number(existing[2]) < TEMPLATE_MAX_AGE_S) return { name, commit };
		const already = making.get(name);
		if (already !== undefined) {
			onStep?.("waiting");
			return { name: await already, commit };
		}
		const prior = priorTemplate(project.name, name, listing);
		const made = (async () => {
			if (prior !== undefined) {
				try {
					onProgress?.(`making the ${project.name} template at ${commit.slice(0, 12)} from ${prior}`);
					if (await make(project, name, prior, onProgress, onStep)) return name;
					onProgress?.("starting again from the base image");
				} catch (error) {
					log(`[sandbox] making ${name} from ${prior} failed, so from the base image: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
					onProgress?.(`that failed; starting again from the base image`);
				}
			} else onProgress?.(`making the ${project.name} template at ${commit.slice(0, 12)}`);
			await make(project, name, undefined, onProgress, onStep);
			return name;
		})().then((made) => {
			// In the background: the first prune after a while has many to drop, one SSH call each.
			void prune(project, made);
			return made;
		});
		making.set(name, made);
		try {
			return { name: await made, commit };
		} finally {
			making.delete(name);
		}
	}

	/**
	 * Makes template `name` for `project` in a new sandbox, from template `from` or the base image, and saves it. False
	 * when the script asked for a start from the base image instead; the sandbox is gone then, as after a failure.
	 */
	async function make(project: ProjectSource, name: string, from: string | undefined, onProgress?: (line: string) => void, onStep?: (step: SandboxStep) => void): Promise<boolean> {
		onStep?.("cloning");
		const n = Number((await stedding("new", ...(from === undefined ? [] : ["--template", from]), ...sizeWords(TEMPLATE_SIZE))).trim());
		try {
			const env = await prepared(n);
			const scratch = await mkdtemp(join(tmpdir(), "aludra-bundle-"));
			let out = "";
			try {
				const bundle = join(scratch, "project.bundle");
				await run("git", ["-C", project.dir, "bundle", "create", bundle, "HEAD"]);
				const branch = (await run("git", ["-C", project.dir, "rev-parse", "--abbrev-ref", "HEAD"])).trim();
				// The project's commit identity, so the agent can commit in the sandbox and sync brings commits back as the user's.
				const who = async (key: string) => (await run("git", ["-C", project.dir, "config", "--get", key]).catch(() => "")).trim();
				const put = await env.writeFile("/home/user/project.bundle", await readFile(bundle), BACKGROUND);
				if (!put.ok) throw put.error;
				const script = templateScript({ dir: sandboxDir(project), branch, from: from !== undefined, userName: await who("user.name"), userEmail: await who("user.email") });
				const onOutput = (text: string) => {
					out += text;
					if (text.includes(`${STEP_MARK}installing`)) onStep?.("installing");
					const shown = text.replace(`${STEP_MARK}installing\n`, "").replace(`${STEP_MARK}fresh\n`, "").trimEnd();
					if (shown !== "") onProgress?.(shown);
				};
				const result = await env.exec(["bash", "-lc", script], { onOutput, timeout: 20 * 60_000 }, BACKGROUND);
				if (!result.ok) throw result.error;
				if (result.value.exitCode !== 0) throw new Error(`setting up ${project.name} failed (exit ${result.value.exitCode}):\n${out.slice(-2000)}`);
			} finally {
				await rm(scratch, { recursive: true, force: true });
			}
			close(n);
			if (out.includes(`${STEP_MARK}fresh`)) {
				await stedding("rm", String(n)).catch(() => {});
				return false;
			}
			onStep?.("saving");
			await stedding("save", String(n), name);
			onProgress?.(`saved ${name}`);
			return true;
		} catch (error) {
			close(n);
			await stedding("rm", String(n)).catch(() => {});
			throw error;
		}
	}

	/** Drops the templates `keep` makes stale (`staleTemplates`); a failure is logged, never thrown. */
	async function prune(project: ProjectSource, keep: string): Promise<void> {
		try {
			for (const stale of staleTemplates(project.name, keep, await stedding("templates"))) {
				await stedding("drop", stale).catch((error: Error) => log(`[sandbox] dropping template ${stale}: ${error.message}`));
			}
		} catch (error) {
			log(`[sandbox] listing templates to drop: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/** An environment on sandbox `n` once it answers. */
	async function prepared(n: number): Promise<ExecutionEnv> {
		const env = new RemoteExecutionEnv({ connection: connection(n), id: `stedding:${n}`, cwd: "/home/user" });
		const ready = await env.exists("/home/user", BACKGROUND);
		if (!ready.ok) throw ready.error;
		return env;
	}

	/**
	 * Brings sandbox `n`'s commits in `dir` back into the local checkout `local`: the sandbox bundles its branch, the
	 * bundle comes back over the pi-env connection, and `git fetch` puts it in branch `into` (default
	 * `sandbox/<n>`), creating or fast-forwarding it, never touching the checked-out branch or the working tree. A
	 * non-fast-forward (the sandbox rewrote history) is refused. Uncommitted work in the sandbox is counted, not fetched.
	 */
	async function sync(n: number, dir: string, local: string, into = `sandbox/${n}`, options: { force?: boolean } = {}): Promise<SyncResult> {
		if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(into) || into.includes("..") || into.endsWith(".lock") || into.endsWith("/")) throw new Error(`not a branch name: ${into}`);
		const env = new RemoteExecutionEnv({ connection: connection(n), id: `stedding:${n}`, cwd: dir });
		const bundle = `/tmp/aludra-sync-${Date.now().toString(36)}.bundle`;
		let out = "";
		const made = await env.exec(["bash", "-c", `set -e; git rev-parse HEAD; git status --porcelain | wc -l; git bundle create -q ${bundle} HEAD`], { onOutput: (t) => (out += t) }, BACKGROUND);
		if (!made.ok) throw made.error;
		if (made.value.exitCode !== 0) throw new Error(`bundling in sandbox ${n} failed: ${out.trim().slice(-500)}`);
		const [head, uncommitted] = out.trim().split("\n");
		const bytes = await env.readBinaryFile(bundle, BACKGROUND);
		await env.remove(bundle, { force: true }, BACKGROUND);
		if (!bytes.ok) throw bytes.error;
		const scratch = await mkdtemp(join(tmpdir(), "aludra-sync-"));
		try {
			const file = join(scratch, "sandbox.bundle");
			await writeFile(file, bytes.value);
			const before = (await run("git", ["-C", local, "rev-parse", "--verify", "--quiet", `refs/heads/${into}`]).catch(() => "")).trim();
			// The checked-out branch can't be fetched into; a sandbox branch never is checked out unless someone did it by hand.
			const current = (await run("git", ["-C", local, "symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "")).trim();
			if (current === into) throw new Error(`${into} is checked out in ${local}; switch away from it first, or sync into another branch`);
			// Forced only for a ship, whose rebase rewrites what the branch had.
			await run("git", ["-C", local, "fetch", file, `${options.force === true ? "+" : ""}HEAD:refs/heads/${into}`]).catch((error: Error) => {
				if (/rejected|non-fast-forward/.test(error.message)) throw new Error(`sandbox ${n} rewrote history that ${into} already has; sync into another branch with --into`);
				throw error;
			});
			const after = (await run("git", ["-C", local, "rev-parse", `refs/heads/${into}`])).trim();
			const base = before === "" ? (await run("git", ["-C", local, "merge-base", "HEAD", after]).catch(() => "")).trim() : before;
			const commits = base === "" ? 0 : Number((await run("git", ["-C", local, "rev-list", "--count", `${base}..${after}`])).trim());
			return { sandbox: n, dir: local, branch: into, head: after, commits, uncommitted: Number(uncommitted) || 0, sandboxHead: head ?? after };
		} finally {
			await rm(scratch, { recursive: true, force: true });
		}
	}

	/**
	 * Puts `ref` of the local checkout `local` into sandbox `n`'s repository at `dir` as `refs/aludra/base`, through a
	 * bundle, for the agent to rebase onto; returns the commit it names.
	 */
	async function receiveBase(n: number, dir: string, local: string, ref: string): Promise<string> {
		const sha = (await run("git", ["-C", local, "rev-parse", "--verify", `${ref}^{commit}`])).trim();
		const scratch = await mkdtemp(join(tmpdir(), "aludra-base-"));
		try {
			const file = join(scratch, "base.bundle");
			await run("git", ["-C", local, "bundle", "create", "-q", file, ref]);
			const env = new RemoteExecutionEnv({ connection: connection(n), id: `stedding:${n}`, cwd: dir });
			const remote = `/tmp/aludra-base-${Date.now().toString(36)}.bundle`;
			const put = await env.writeFile(remote, await readFile(file), BACKGROUND);
			if (!put.ok) throw put.error;
			let out = "";
			const fetched = await env.exec(["bash", "-c", `set -e; git fetch -q ${remote} +${ref}:refs/aludra/base; rm -f ${remote}; git rev-parse refs/aludra/base`], { onOutput: (t) => (out += t) }, BACKGROUND);
			if (!fetched.ok) throw fetched.error;
			if (fetched.value.exitCode !== 0 || out.trim().split("\n").at(-1) !== sha) throw new Error(`giving sandbox ${n} the base failed: ${out.trim().slice(-500)}`);
			return sha;
		} finally {
			await rm(scratch, { recursive: true, force: true });
		}
	}

	return {
		configured: () => host !== undefined,
		sync,
		receiveBase,
		/**
		 * A new sandbox for a session: from `project`'s template, or the base image with none. Returns its number, the
		 * project's directory in it, and the commit it was made from. `onStep` hears each stage as it starts.
		 */
		async create(project?: ProjectSource, onProgress?: (line: string) => void, onStep?: (step: SandboxStep) => void, size?: SandboxSize): Promise<{ sandbox: number; dir: string; base?: string }> {
			if (project === undefined) return { sandbox: Number((await stedding("new", ...sizeWords(size))).trim()), dir: "/home/user" };
			let { name, commit } = await template(project, onProgress, onStep);
			onStep?.("starting");
			const fromTemplate = () => stedding("new", "--template", name, ...sizeWords(size));
			// A template for a newer commit, saved meanwhile, drops this one; then the newer one serves.
			const made = await fromTemplate().catch(async (error: Error) => {
				if (!/no template/.test(error.message)) throw error;
				({ name, commit } = await template(project, onProgress, onStep));
				return fromTemplate();
			});
			return { sandbox: Number(made.trim()), dir: sandboxDir(project), base: commit };
		},
		/** Where `project` is in its sandboxes. */
		dirFor: (project: ProjectSource) => sandboxDir(project),
		/** The environment for a session on sandbox `n` working in `cwd`; equal ids see the same files. */
		env(n: number, cwd: string): ExecutionEnv {
			if (!projectDirs.has(n)) projectDirs.set(n, cwd);
			return new RemoteExecutionEnv({ connection: connection(n), id: `stedding:${n}`, cwd });
		},
		/** Deletes sandbox `n` on its host. */
		async remove(n: number): Promise<void> {
			close(n);
			await stedding("rm", String(n));
		},
		status: (n: number) => stedding("status", String(n)).then((s) => s.trim()),
		/** Every sandbox's state on its host: running, paused or stopped. */
		async states(): Promise<Map<number, string>> {
			const out = new Map<number, string>();
			for (const line of (await stedding("status")).split("\n")) {
				const m = /^sandbox=(\d+) state=(\w+)/.exec(line);
				if (m !== null) out.set(Number(m[1]), m[2]!);
			}
			return out;
		},
		/** Whether this process holds a connection to sandbox `n`. */
		connected: (n: number) => live.has(n),
		/** Drops sandbox `n`'s connection, or all, as being idle would. */
		close(n?: number) {
			if (n !== undefined) close(n);
			else for (const k of Array.from(live.keys())) close(k);
		},
	};
}

export type Sandboxes = ReturnType<typeof createSandboxes>;

/** What a sync brought back: `commits` new on `branch` in `dir` since it last was synced (or since it forked from HEAD). */
export type SyncResult = { sandbox: number; dir: string; branch: string; head: string; commits: number; uncommitted: number; sandboxHead: string };

/** What `fastForward` did: moved `onto` to `branch`'s head, or why it didn't. */
export type MergeResult = { merged: true; onto: string; commits: number } | { merged: false; reason: string };

/**
 * Fast-forwards the branch checked out in `local` to `branch`, if that's safe: the checkout is on a branch, `branch`
 * contains it (so nothing on it is lost and no merge commit is made), and no uncommitted change touches a file the
 * new commits change. Otherwise it changes nothing and says why. `git merge --ff-only` does the work, so a change it
 * would overwrite still stops it.
 */
export async function fastForward(local: string, branch: string): Promise<MergeResult> {
	const git = (...args: string[]) => run("git", ["-C", local, ...args]);
	const onto = (await git("symbolic-ref", "--quiet", "--short", "HEAD").catch(() => "")).trim();
	if (onto === "") return { merged: false, reason: "the checkout isn't on a branch" };
	if (onto === branch) return { merged: false, reason: `${branch} is the checked-out branch` };
	const head = (await git("rev-parse", "HEAD")).trim();
	const tip = (await git("rev-parse", `refs/heads/${branch}`)).trim();
	if (head === tip) return { merged: false, reason: `${onto} already has it` };
	const contains = await git("merge-base", "--is-ancestor", head, tip).then(() => true, () => false);
	if (!contains) return { merged: false, reason: `${onto} has commits ${branch} doesn't; merge it yourself (git merge ${branch})` };
	const changed = new Set((await git("diff", "--name-only", head, tip)).split("\n").filter(Boolean));
	const dirty = (await git("status", "--porcelain", "-z")).split("\0").filter(Boolean).map((line) => line.slice(3));
	const clash = dirty.filter((path) => changed.has(path));
	if (clash.length > 0) return { merged: false, reason: `uncommitted changes to ${clash.slice(0, 3).join(", ")}${clash.length > 3 ? ` and ${clash.length - 3} more` : ""} would be overwritten` };
	const commits = Number((await git("rev-list", "--count", `${head}..${tip}`)).trim());
	try {
		await git("merge", "--ff-only", "--quiet", tip);
	} catch (error) {
		return { merged: false, reason: `git merge --ff-only refused: ${error instanceof Error ? error.message.split("\n").slice(-1)[0] : String(error)}` };
	}
	return { merged: true, onto, commits };
}

/**
 * Deletes branch `branch` of the local checkout `local`, unmerged commits and all, unless it's checked out. Returns the
 * commit it was at, or undefined when there was no such branch.
 */
export async function deleteBranch(local: string, branch: string): Promise<string | undefined> {
	const git = (...args: string[]) => run("git", ["-C", local, ...args]);
	const head = (await git("rev-parse", "--verify", "--quiet", `refs/heads/${branch}`).catch(() => "")).trim();
	if (head === "") return undefined;
	const current = (await git("symbolic-ref", "--quiet", "--short", "HEAD").catch(() => "")).trim();
	if (current === branch) throw new Error(`${branch} is checked out in ${local}; switch away from it first`);
	// Only if it's still where it was read, so a sync landing meanwhile isn't lost.
	await git("update-ref", "-d", `refs/heads/${branch}`, head);
	return head;
}

function shellQuote(text: string): string {
	return `'${text.replaceAll("'", "'\\''")}'`;
}
