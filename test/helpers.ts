import assert from "node:assert/strict";
import { createDecipheriv, createECDH, type ECDH, hkdfSync, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import { fauxProvider, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import type { Bridge } from "../src/bridge.ts";
import { configFor } from "../src/config.ts";
import { openHost, type HostOptions } from "../src/host.ts";
import type { Project } from "../src/projects.ts";

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

/** What a fake bridge saw of each request. */
export type Seen = { cwd: string; options: SimpleStreamOptions; context: TranscriptContext };

/**
 * A stand-in for pi-claude-bridge that answers with the faux provider and records what the wrapper sends it: the
 * directory it was called in, its options, its context, the prompts recorded and the sessions it was told were rewritten.
 */
export function fakeBridge(responses: FauxResponseStep[]) {
	const faux = fauxProvider({ provider: "claude-bridge", models: [{ id: "claude-opus-5-5", contextWindow: 1_000_000 }] });
	faux.setResponses(responses);
	const seen: Seen[] = [];
	const prompts: string[] = [];
	const rewritten: string[] = [];
	const handlers = new Map([["session_compact", [(_event: object, ctx: object) => {
		// SAFETY: the wrapper calls this handler with a context whose session manager names the session.
		rewritten.push((ctx as { sessionManager: { getSessionId(): string } }).sessionManager.getSessionId());
	}]]]);
	const bridge: Bridge = {
		models: faux.models,
		streamSimple: (model, context, options = {}) => {
			seen.push({ cwd: process.cwd(), options, context });
			return faux.provider.streamSimple(model, context, options);
		},
		handlers,
		systemPromptOf: (context) => {
			const system = context.messages.filter((m) => m.role === "system");
			return system.length === 0 ? undefined : JSON.stringify(system.map((m) => m.sections ?? m.content));
		},
		recordPrompt: (prompt) => void prompts.push(prompt),
	};
	return { bridge, faux, seen, prompts, rewritten };
}

/** A host on a temp data directory with `options`, closed after the test. */
export async function testHost(t: TestContext, options: Omit<HostOptions, "config"> & { approvalHosts?: string[] } = {}) {
	const dir = tempDir(t);
	const { config } = configFor(JSON.stringify({ dataDir: join(dir, "data"), workspaces: [{ name: "test", roots: [join(dir, "Projects", "*", "*")] }], approvals: { hosts: options.approvalHosts ?? ["build-box"] } }), {});
	const agentDir = join(dir, "agent");
	mkdirSync(agentDir, { recursive: true });
	const host = await openHost({ agentDir, onNotice: () => {}, ...options, config });
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
