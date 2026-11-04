import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createDecipheriv, createECDH, type ECDH, hkdfSync, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import type { SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai/models";
import { fauxProvider, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { Connection, localDaemon } from "@earendil-works/pi-env";
import { configFor } from "../src/config.ts";
import { openHost, type HostOptions } from "../src/host.ts";
import type { Project } from "../src/projects.ts";
import { createSandboxes, type Sandboxes } from "../src/sandboxes.ts";

export function tempDir(t: TestContext, name = "aludra-test-"): string {
	// Resolved, since a process's cwd is (macOS's temporary directory is under the /var symlink).
	const dir = realpathSync(mkdtempSync(join(tmpdir(), name)));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/** A project directory `name` under `root`, with `files` in it. */
export function makeProject(root: string, name: string, files: Record<string, string> = {}): Project {
	const dir = join(root, "Projects", "Software", name);
	mkdirSync(dir, { recursive: true });
	for (const [file, text] of Object.entries(files)) {
		mkdirSync(join(dir, file, ".."), { recursive: true });
		writeFileSync(join(dir, file), text);
	}
	return { workspace: "test", name, path: `Software/${name}`, dir };
}

/** What a fake Claude Code provider saw of each request. */
export type Seen = { cwd: string; options: SimpleStreamOptions; context: TranscriptContext };

/** A stand-in for pi-claude-code's provider that answers with the faux provider and records the directory each request was made in, its options and its context. */
export function fakeClaudeCode(responses: FauxResponseStep[]) {
	const faux = fauxProvider({ provider: "claude-code", models: [{ id: "claude-opus-5-5", contextWindow: 1_000_000 }] });
	faux.setResponses(responses);
	const seen: Seen[] = [];
	const claudeCode: Provider = {
		...faux.provider,
		streamSimple: (model, context, options = {}) => {
			seen.push({ cwd: process.cwd(), options, context });
			return faux.provider.streamSimple(model, context, options);
		},
	};
	return { claudeCode, faux, seen };
}

/**
 * A host on a temp data directory with `options`, closed after the test. With `settingsFile`, its settings are read from
 * config.json in the temp directory, so they can be changed. `settings` are added to the settings file's, and `dir`
 * opens a host on another host's directory, as a restart does.
 */
export async function testHost(t: TestContext, options: Omit<HostOptions, "config"> & { approvalHosts?: string[]; settingsFile?: boolean; settings?: Record<string, unknown>; dir?: string } = {}) {
	const dir = options.dir ?? tempDir(t);
	const text = JSON.stringify({ dataDir: join(dir, "data"), workspaces: [{ name: "test", roots: [join(dir, "Projects", "*", "*")] }], approvals: { hosts: options.approvalHosts ?? ["build-box"] }, ...options.settings }, null, "\t");
	const { config } = configFor(text, {});
	if (options.settingsFile === true) {
		config.file = join(dir, "config.json");
		writeFileSync(config.file, text);
	}
	const agentDir = join(dir, "agent");
	mkdirSync(agentDir, { recursive: true });
	const host = await openHost({ agentDir, ...options, config });
	t.after(() => host.close());
	host.resume();
	return { host, dir, agentDir, config };
}

const hkdf = (salt: Buffer, ikm: Buffer, info: Buffer | string, length: number) => Buffer.from(hkdfSync("sha256", ikm, salt, info, length));

/** What a device does with a push: the receiving half of RFC 8291. */
export function decrypt(body: Buffer, device: ECDH, auth: Buffer): string {
	const salt = body.subarray(0, 16);
	const senderPublic = body.subarray(21, 21 + body[20]!);
	const sealed = body.subarray(21 + body[20]!);
	const ikm = hkdf(auth, device.computeSecret(senderPublic), Buffer.concat([Buffer.from("WebPush: info\0"), device.getPublicKey(), senderPublic]), 32);
	const decipher = createDecipheriv("aes-128-gcm", hkdf(salt, ikm, "Content-Encoding: aes128gcm\0", 16), hkdf(salt, ikm, "Content-Encoding: nonce\0", 12));
	decipher.setAuthTag(sealed.subarray(-16));
	const plain = Buffer.concat([decipher.update(sealed.subarray(0, -16)), decipher.final()]);
	assert.equal(plain.at(-1), 2, "the padding delimiter");
	return plain.subarray(0, -1).toString("utf8");
}

export function device() {
	const ecdh = createECDH("prime256v1");
	ecdh.generateKeys();
	const auth = randomBytes(16);
	return { ecdh, auth, p256dh: ecdh.getPublicKey("base64url"), authText: auth.toString("base64url") };
}

/** A 1×1 PNG, base64. */
export const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
export const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: GIT_ENV }).trim();

/** Settings naming a sandbox host, for a host given fakeSandboxes: only the parts the settings check. */
export const SANDBOX_SETTINGS = { sandboxes: { ssh: "unused", gateKey: "/dev/null", knownHosts: "/dev/null", sandboxKey: "/dev/null", sandboxHostKey: "ssh-ed25519 AAAA" } };

/**
 * Sandboxes on this machine: each "sandbox" is a clone of its project in `root`, with no remote, as a template makes,
 * reached through pi-env's local daemon, so tools, sync and ship run for real. `create` waits for `release()` while
 * `hold` is set, and fails with `fail`'s message when that's set. Numbers count from 0 like stedding's.
 */
export function fakeSandboxes(root: string) {
	const real = createSandboxes({ ssh: "unused", gateKey: "/dev/null", hostKnownHosts: "/dev/null", sandboxKey: "/dev/null", sandboxHostKey: "ssh-ed25519 AAAA", dataDir: root }, { connect: () => new Connection({ command: [localDaemon()] }) });
	let next = 0;
	const made: { n: number; dir: string }[] = [];
	const removed: number[] = [];
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
		async create(project, _onProgress, onStep) {
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
	return { sandboxes, control, made, removed, close: () => real.close() };
}

/** `makeProject` in git, with one commit, and with `remote` a bare repository it tracks as origin/main. */
export function gitProject(root: string, name: string, files: Record<string, string> = { "a.txt": "one\n" }, options: { remote?: boolean } = {}) {
	const project = makeProject(root, name, files);
	git(project.dir, "init", "-q", "-b", "main");
	git(project.dir, "add", "-A");
	git(project.dir, "commit", "-q", "-m", "first");
	if (options.remote !== true) return { project };
	const remote = join(root, `${name}.git`);
	execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
	git(project.dir, "remote", "add", "origin", remote);
	git(project.dir, "push", "-q", "-u", "origin", "main");
	return { project, remote };
}
