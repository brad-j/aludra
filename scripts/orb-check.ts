// The orb spike's live check, run by hand against an orb: a real model (the settings' default, so Claude through the
// user's Claude Code) in a session whose tools run on the orb. The host runs in a temp data directory.
//
//   node --no-warnings scripts/orb-check.ts ORB_SETTINGS_JSON [REPO_URL] [--pause "ssh-args-to-run: stedding pause N"]
//
// ORB_SETTINGS_JSON is one entry of `orbs` in the settings. Turn 1: the session clones REPO_URL on the orb, installs,
// runs its tests, and starts a long-lived process with setsid. Then, with --pause, the check closes the connection and
// pauses the orb through the given command, and turn 2 asks whether that process is still running and what the
// clone's last commit is. The orb wakes on turn 2's first call.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configFor } from "../src/config.ts";
import { context, openHost, type Host } from "../src/host.ts";
import { describeAnswer } from "../src/server.ts";

const args = process.argv.slice(2);
const pauseAt = args.indexOf("--pause");
const pauseCommand = pauseAt === -1 ? undefined : args.splice(pauseAt, 2)[1]!.split(" ");
const [orbFile, repo = "https://github.com/sindresorhus/is.git"] = args;
if (orbFile === undefined) throw new Error("usage: orb-check.ts ORB_SETTINGS_JSON [REPO_URL] [--pause CMD]");
const orb = JSON.parse(readFileSync(orbFile, "utf8"));
const root = mkdtempSync(join(tmpdir(), "aludra-orb-"));
const dir = `/home/user/work/check-${Date.now().toString(36)}`;
const config = configFor(JSON.stringify({ dataDir: join(root, "data"), workspaces: [{ name: "x", roots: [] }], model: { thinking: "low" }, orbs: [{ ...orb, name: "check" }] }), {}).config;

async function turn(host: Host, id: number, text: string) {
	const started = Date.now();
	const settled = await (await host.submit(id, text)).wait(context);
	const entries = (await (await host.conversation(id)).context(context)).entries;
	const calls = entries.flatMap((e) => (e.model ?? []).flatMap((m) => (m.role === "assistant" ? m.content.flatMap((c) => (c.type === "toolCall" ? [c] : [])) : [])));
	console.log(`status: ${settled.status}${settled.status === "done" ? "" : ` (${settled.reason})`} in ${Math.round((Date.now() - started) / 1000)}s, ${calls.length} tool calls so far`);
	console.log("--- answer ---\n" + (describeAnswer(entries.at(-1)) ?? "(none)") + "\n--------------");
}

const host = await openHost({ config });
host.resume();
try {
	const session = await host.sessions.createOrb("check", "/home/user", "orb check");
	await turn(host, session.id, [
		`Clone ${repo} into ${dir} with git (shallow is fine), install its dependencies with pnpm, and run its tests.`,
		"Then start a background process that survives your shell: `setsid -f sh -c 'echo $$ > ~/keeper.pid; while :; do sleep 1; done' </dev/null >/dev/null 2>&1`.",
		"Use bash for each step. Reply with the hostname, the Node version, whether the tests passed (with a count if printed), and the keeper's pid. Keep it short.",
	].join(" "));

	if (pauseCommand !== undefined) {
		host.orbs.close();
		await new Promise((resolve) => setTimeout(resolve, 1000));
		const [cmd, ...rest] = pauseCommand;
		console.log(`\npausing: ${execFileSync(cmd!, rest, { encoding: "utf8" }).trim()}\n`);
		await new Promise((resolve) => setTimeout(resolve, 5000));
	}

	await turn(host, session.id, `Check, with bash: is the process whose pid is in ~/keeper.pid still running, and what is the last commit in ${dir}? Also print \`uptime\`. Reply in two or three lines.`);
	console.log(`on this machine: ${existsSync(dir) ? `FAIL ${dir} exists here` : `ok, no ${dir} here`}`);
} finally {
	await host.close();
	rmSync(root, { recursive: true, force: true });
}
