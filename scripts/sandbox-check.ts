// The sandbox spike's live check, run by hand against a sandbox host: a real model (the settings' default, so Claude through
// the user's Claude Code) in sessions whose tools run in sandboxes of their own. The host runs in a temp data directory.
//
//   node --no-warnings scripts/sandbox-check.ts SANDBOX_HOST_JSON PROJECT_DIR
//
// SANDBOX_HOST_JSON is the `sandboxes` setting. Session 1 is the first for PROJECT_DIR's commit, so it waits while the
// template is made; session 2 reuses the template. Each runs the project's tests on its sandbox. Then session 1 starts a
// setsid process, its connection is dropped, the check waits for the host's reaper to pause the sandbox, and a last turn
// wakes it and finds the process. Both sandboxes are deleted at the end.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { configFor } from "../src/config.ts";
import { context, openHost, type Host } from "../src/host.ts";
import { describeAnswer } from "../src/server.ts";

const [hostFile, projectDir] = process.argv.slice(2);
if (hostFile === undefined || projectDir === undefined) throw new Error("usage: sandbox-check.ts SANDBOX_HOST_JSON PROJECT_DIR");
const sandboxesSetting = JSON.parse(readFileSync(hostFile, "utf8"));
const root = mkdtempSync(join(tmpdir(), "aludra-sandbox-"));
const config = configFor(JSON.stringify({ dataDir: join(root, "data"), workspaces: [{ name: "x", roots: [] }], model: { thinking: "low" }, sandboxes: sandboxesSetting }), {}).config;
const project = { workspace: "x", name: basename(projectDir), path: `${basename(dirname(projectDir))}/${basename(projectDir)}`, dir: projectDir };
const seconds = (since: number) => `${Math.round((Date.now() - since) / 1000)}s`;

async function turn(host: Host, id: number, text: string) {
	const started = Date.now();
	const settled = await (await host.submit(id, text)).wait(context);
	const entries = (await (await host.conversation(id)).context(context)).entries;
	console.log(`  turn: ${settled.status}${settled.status === "done" ? "" : ` (${settled.reason})`} in ${seconds(started)}`);
	console.log("  " + (describeAnswer(entries.at(-1)) ?? "(none)").replaceAll("\n", "\n  "));
}

const TEST_TASK = "Use bash. Run this project's tests (look at package.json or the like for how), and reply in four short lines: the hostname, the working directory, whether the tests passed with the count if printed, and the first heading of the project's AGENTS.md as your instructions give it (not read from disk). Don't install anything first unless the tests fail for a missing dependency.";
const host = await openHost({ config });
host.resume();
const sandboxesMade: number[] = [];
try {
	let t = Date.now();
	const one = await host.sessions.createSandbox(project, "sandbox check one", {}, (line) => line.trim() && console.log(`    | ${line.split("\n").at(-1)!.slice(0, 120)}`));
	sandboxesMade.push(one.sandbox!);
	console.log(`session 1 on sandbox ${one.sandbox} in ${one.dir}: created in ${seconds(t)} (made the template)`);
	await turn(host, one.id, TEST_TASK);

	t = Date.now();
	const two = await host.sessions.createSandbox(project, "sandbox check two");
	sandboxesMade.push(two.sandbox!);
	console.log(`session 2 on sandbox ${two.sandbox}: created in ${seconds(t)} (reused the template)`);
	await turn(host, two.id, TEST_TASK);

	await turn(host, one.id, "Use bash to start a process that outlives your shell: `setsid -f sh -c 'echo $$ > ~/keeper.pid; while :; do sleep 1; done' </dev/null >/dev/null 2>&1`, then reply with its pid only.");
	host.sandboxes.close(one.sandbox);
	console.log(`waiting for the host's reaper to pause sandbox ${one.sandbox}...`);
	t = Date.now();
	while (!(await host.sandboxes.status(one.sandbox!)).includes("state=paused")) {
		if (Date.now() - t > 240_000) throw new Error("the sandbox wasn't paused within 4 minutes");
		await new Promise((resolve) => setTimeout(resolve, 5000));
	}
	console.log(`paused after ${seconds(t)}: ${await host.sandboxes.status(one.sandbox!)}`);
	await turn(host, one.id, "With bash: is the process whose pid is in ~/keeper.pid still running? Reply in one line.");
	console.log(`on this machine: ${existsSync("/home/user/work") ? "FAIL /home/user/work exists here" : "ok, nothing at /home/user/work"}`);
} finally {
	for (const n of sandboxesMade) await host.sandboxes.remove(n).catch((error) => console.error(`removing sandbox ${n}: ${error.message}`));
	await host.close();
	rmSync(root, { recursive: true, force: true });
}
