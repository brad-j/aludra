// The orb spike's live check, run by hand against a running orb: a real model (the settings' default, so Claude through
// the user's Claude Code) in a session whose tools run on the orb. The host runs in a temp data directory.
//
//   node --no-warnings scripts/orb-check.ts ORB_SETTINGS_JSON [REPO_URL]
//
// ORB_SETTINGS_JSON is one entry of `orbs` in the settings, with name "check". The session clones REPO_URL on the orb,
// installs and runs its tests, and reports what it found. Then the check asks the orb directly what's there, and that
// nothing of the session's reached this machine.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configFor } from "../src/config.ts";
import { context, openHost } from "../src/host.ts";
import { describeAnswer } from "../src/server.ts";

const [orbFile, repo = "https://github.com/sindresorhus/is.git"] = process.argv.slice(2);
if (orbFile === undefined) throw new Error("usage: orb-check.ts ORB_SETTINGS_JSON [REPO_URL]");
const orb = JSON.parse(readFileSync(orbFile, "utf8"));
const root = mkdtempSync(join(tmpdir(), "aludra-orb-"));
const dir = `/home/user/work/check-${Date.now().toString(36)}`;
const config = configFor(JSON.stringify({ dataDir: join(root, "data"), workspaces: [{ name: "x", roots: [] }], model: { thinking: "low" }, orbs: [{ ...orb, name: "check" }] }), {}).config;

const host = await openHost({ config });
host.resume();
const started = Date.now();
try {
	const session = await host.sessions.createOrb("check", "/home/user", "orb check");
	const task = [
		`Clone ${repo} into ${dir} with git (shallow is fine), install its dependencies with pnpm, and run its tests.`,
		"Use bash for each step. Then reply with: the output of `uname -a` and `hostname`, the Node and pnpm versions,",
		"and one line saying whether the tests passed, with the count if the runner prints one. Keep the reply short.",
	].join(" ");
	const run = await host.submit(session.id, task);
	const settled = await run.wait(context);
	const entries = (await (await host.conversation(session.id)).context(context)).entries;
	const calls = entries.flatMap((e) => (e.model ?? []).flatMap((m) => (m.role === "assistant" ? m.content.flatMap((c) => (c.type === "toolCall" ? [c] : [])) : [])));
	console.log(`status: ${settled.status}${settled.status === "done" ? "" : ` (${settled.reason})`} in ${Math.round((Date.now() - started) / 1000)}s, ${calls.length} tool calls: ${calls.map((c) => c.name).join(", ")}`);
	console.log("\n--- answer ---\n" + (describeAnswer(entries.at(-1)) ?? "(none)") + "\n--------------");

	// Ask the orb directly, through the same environment the tools used.
	const { createOrbs } = await import("../src/orbs.ts");
	const orbs = createOrbs({ check: { host: orb.host, knownHostsFile: orb.knownHosts, hostKeyAlias: orb.hostKeyAlias, ...(orb.user ? { user: orb.user } : {}), ...(orb.identityFile ? { identityFile: orb.identityFile } : {}), ...(orb.sshConfig ? { configFile: orb.sshConfig } : {}) } });
	const env = orbs.env("check", "/home/user");
	let out = "";
	const result = await env.exec(`test -d ${dir}/node_modules && echo has-node_modules; git -C ${dir} log --oneline -1; hostname`, { onOutput: (t) => (out += t) }, context);
	console.log(`on the orb (exit ${result.ok ? result.value.exitCode : "error"}):\n${out.trim()}`);
	orbs.close();
	console.log(`on this machine: ${existsSync(dir) ? `FAIL ${dir} exists here` : `ok, no ${dir} here`}`);
} finally {
	await host.close();
	rmSync(root, { recursive: true, force: true });
}
