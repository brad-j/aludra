// Sandboxes (spike): sessions whose tools run in a stedding sandbox, a Firecracker microVM on another machine, through pi-env's
// daemon over SSH. The agent loop, the transcript and the model stay here.
//
// Each sandbox session gets its own sandbox, made from its project's template: the base image with the project cloned and its
// dependencies installed, saved once and reused for 24 hours or until the project's commit changes. Everything on the
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

type Live = { connection: Connection; inFlight: number; timer?: NodeJS.Timeout };

const TEMPLATE_MAX_AGE_S = 24 * 3600;

function run(cmd: string, args: readonly string[], input?: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (error) reject(new Error(`${cmd} ${args.at(-1)}: ${stderr.trim() || error.message}`));
			else resolve(stdout);
		});
		if (input !== undefined) child.stdin?.end(input);
	});
}

/** A template name for `project` at `commit`: safe for stedding, stable while the commit is. */
export function templateName(project: string, commit: string): string {
	return `${project.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[^A-Za-z0-9]+/, "p")}-${commit.slice(0, 12)}`;
}

export function createSandboxes(host: SandboxHost | undefined, options: { idleMs?: number; connect?: (sandbox: number, target: SshConnectOptions) => Connection } = {}) {
	const idleMs = options.idleMs ?? 60_000;
	const live = new Map<number, Live>();
	const making = new Map<string, Promise<string>>();

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

	/** The connection to sandbox `n`, made on first use; the SSH target is written then. */
	function connection(n: number): Connection {
		const found = live.get(n);
		if (found !== undefined) return found.connection;
		const connect = options.connect;
		let inner: Connection | undefined;
		let starting: Promise<Connection> | undefined;
		const start = () => (starting ??= (async () => {
			const t = await target(n);
			inner = connect !== undefined ? connect(n, t) : sshConnection({ ...t, onLog: (text) => console.error(`[sandbox ${n}] ${text.trimEnd()}`) }).connection;
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
	 * The template for `project`'s current commit, made if missing or older than a day: a fresh sandbox clones the project
	 * from a bundle, runs `.agents/setup` if the project has one, else installs with the lockfile's package manager,
	 * and is saved. Concurrent calls for one template share the work.
	 */
	async function template(project: ProjectSource, onProgress?: (line: string) => void): Promise<string> {
		const commit = (await run("git", ["-C", project.dir, "rev-parse", "HEAD"])).trim();
		const name = templateName(project.name, commit);
		const existing = (await stedding("templates")).split("\n").map((l) => /^template=(\S+) age=(\d+)/.exec(l)).find((m) => m?.[1] === name);
		if (existing && Number(existing[2]) < TEMPLATE_MAX_AGE_S) return name;
		const already = making.get(name);
		if (already !== undefined) return already;
		const made = (async () => {
			onProgress?.(`making the ${project.name} template at ${commit.slice(0, 12)}`);
			const n = Number((await stedding("new")).trim());
			try {
				const env = await prepared(n);
				const scratch = await mkdtemp(join(tmpdir(), "aludra-bundle-"));
				try {
					const bundle = join(scratch, "project.bundle");
					await run("git", ["-C", project.dir, "bundle", "create", bundle, "HEAD"]);
					const branch = (await run("git", ["-C", project.dir, "rev-parse", "--abbrev-ref", "HEAD"])).trim();
					// The project's commit identity, so the agent can commit in the sandbox and sync brings commits back as the user's.
					const who = async (key: string) => (await run("git", ["-C", project.dir, "config", "--get", key]).catch(() => "")).trim();
					const [userName, userEmail] = [await who("user.name"), await who("user.email")];
					const put = await env.writeFile("/home/user/project.bundle", await readFile(bundle), BACKGROUND);
					if (!put.ok) throw put.error;
					const dir = `/home/user/work/${project.name}`;
					const script = [
						"set -euo pipefail",
						`git clone -q --branch ${branch === "HEAD" ? "HEAD" : shellQuote(branch)} ~/project.bundle ${shellQuote(dir)} 2>/dev/null || git clone -q ~/project.bundle ${shellQuote(dir)}`,
						`cd ${shellQuote(dir)} && git remote remove origin && rm ~/project.bundle`,
						...(userName === "" ? [] : [`git config --global user.name ${shellQuote(userName)}`]),
						...(userEmail === "" ? [] : [`git config --global user.email ${shellQuote(userEmail)}`]),
						"if [ -x .agents/setup ]; then .agents/setup",
						"elif [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile",
						"elif [ -f package-lock.json ]; then npm ci",
						"elif [ -f package.json ]; then pnpm install",
						"elif [ -f Cargo.toml ]; then command -v cargo >/dev/null && cargo fetch || echo 'no cargo in the image; .agents/setup can install it'",
						"elif [ -f requirements.txt ]; then python3 -m venv .venv && .venv/bin/pip install -q -r requirements.txt",
						"fi",
						"sync",
					].join("\n");
					let out = "";
					const result = await env.exec(["bash", "-lc", script], { onOutput: (text) => { out += text; onProgress?.(text.trimEnd()); }, timeout: 20 * 60_000 }, BACKGROUND);
					if (!result.ok) throw result.error;
					if (result.value.exitCode !== 0) throw new Error(`setting up ${project.name} failed (exit ${result.value.exitCode}):\n${out.slice(-2000)}`);
				} finally {
					await rm(scratch, { recursive: true, force: true });
				}
				close(n);
				await stedding("save", String(n), name);
				onProgress?.(`saved ${name}`);
				return name;
			} catch (error) {
				close(n);
				await stedding("rm", String(n)).catch(() => {});
				throw error;
			}
		})();
		making.set(name, made);
		try {
			return await made;
		} finally {
			making.delete(name);
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
	async function sync(n: number, dir: string, local: string, into = `sandbox/${n}`): Promise<SyncResult> {
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
			await run("git", ["-C", local, "fetch", file, `HEAD:refs/heads/${into}`]).catch((error: Error) => {
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

	return {
		configured: () => host !== undefined,
		sync,
		/** A new sandbox for a session: from `project`'s template, or the base image with none. Returns its number. */
		async create(project?: ProjectSource, onProgress?: (line: string) => void): Promise<{ sandbox: number; dir: string }> {
			if (project === undefined) return { sandbox: Number((await stedding("new")).trim()), dir: "/home/user" };
			const name = await template(project, onProgress);
			return { sandbox: Number((await stedding("new", "--template", name)).trim()), dir: `/home/user/work/${project.name}` };
		},
		/** The environment for a session on sandbox `n` working in `cwd`; equal ids see the same files. */
		env(n: number, cwd: string): ExecutionEnv {
			return new RemoteExecutionEnv({ connection: connection(n), id: `stedding:${n}`, cwd });
		},
		/** Deletes sandbox `n` on its host. */
		async remove(n: number): Promise<void> {
			close(n);
			await stedding("rm", String(n));
		},
		status: (n: number) => stedding("status", String(n)).then((s) => s.trim()),
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


function shellQuote(text: string): string {
	return `'${text.replaceAll("'", "'\\''")}'`;
}
