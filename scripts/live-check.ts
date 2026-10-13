// The live check, run by hand: real pi-claude-bridge, real Claude Code, the user's own login. Rerun it after upgrading
// Pi Durable or the bridge. It works in a temp directory and removes the Claude Code session files it made.
//
//   node --no-warnings scripts/live-check.ts
//
// 1. Two sessions at once, each in its own project directory with its own AGENTS.md: each answer names its own
//    directory and codeword, and Claude Code's session files land under each project's directory.
// 2. A compaction, then a question only the summary can answer.
// 3. kill -9 during a tool call; after the restart the run finishes the remaining steps.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { configFor } from "../src/config.ts";
import { context, openHost, type Host } from "../src/host.ts";
import type { Project } from "../src/projects.ts";
import { describeAnswer } from "../src/server.ts";

const [mode, dataDir, crashDir] = process.argv.slice(2);
const config = (dir: string) => configFor(JSON.stringify({ dataDir: dir, model: { thinking: "low" } }), {}).config;
const project = (dir: string): Project => ({ workspace: "live", name: dir.split("/").at(-1)!, path: dir, dir });
const CRASH_TASK = "Use bash for each step, one call per step: 1. `sleep 20 && echo step1 > notes.txt` 2. `echo step2 >> notes.txt` 3. `cat notes.txt`. Then reply with the file's contents.";

async function answer(host: Host, id: number): Promise<string> {
	const entries = (await (await host.conversation(id)).context(context)).entries;
	return describeAnswer(entries.at(-1)) ?? "(no answer)";
}

async function ask(host: Host, id: number, text: string): Promise<string> {
	const settled = await (await host.submit(id, text)).wait(context);
	return settled.status === "done" ? answer(host, id) : `(${settled.status}: ${settled.reason})`;
}

// The child: starts the crash task and says when its first command is running; the parent kills it with -9.
if (mode === "--crash-child") {
	const host = await openHost({ config: config(dataDir!) });
	host.resume();
	const session = await host.sessions.create(project(crashDir!), "crash");
	await host.submit(session.id, CRASH_TASK);
	while (!existsSync(join(crashDir!, ".started"))) {
		const live = await host.harness.snapshot((await import("@earendil-works/pi-durable")).LiveDoc, (await host.conversation(session.id)).id, context);
		if (live?.tools?.some((t) => t.status === "running")) writeFileSync(join(crashDir!, ".started"), String(session.id));
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	await new Promise(() => {});
}

const root = mkdtempSync(join(tmpdir(), "aludra-live-"));
const results: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, detail: string) => {
	results.push([name, ok, detail]);
	console.log(`${ok ? "ok  " : "FAIL"}  ${name}: ${detail}`);
};
const notices: string[] = [];
const data = join(root, "data");

try {
	const one = join(root, "one");
	const two = join(root, "two");
	for (const [dir, word] of [[one, "heron"], [two, "lantern"]] as const) {
		mkdirSync(dir);
		writeFileSync(join(dir, "AGENTS.md"), `The codeword for this project is ${word}.`);
	}
	// Keeps little verbatim, so a manual compaction of a short conversation still summarizes something.
	let host = await openHost({ config: config(data), onNotice: (n) => notices.push(n.message), compaction: { keepRecentTokens: 50 } });
	host.resume();

	// 1
	const prompt = "Run pwd with bash. Then reply with one line: the directory, and the codeword from your project instructions.";
	const [a, b] = [await host.sessions.create(project(one), "one"), await host.sessions.create(project(two), "two")];
	const started = Date.now();
	const [answerA, answerB] = await Promise.all([ask(host, a.id, prompt), ask(host, b.id, prompt)]);
	const seconds = Math.round((Date.now() - started) / 1000);
	check("two at once, session one", answerA.includes(one) && /heron/i.test(answerA), answerA);
	check("two at once, session two", answerB.includes(two) && /lantern/i.test(answerB), `${answerB} (${seconds}s for both)`);
	const ccProjects = join(homedir(), ".claude", "projects");
	const ours = readdirSync(ccProjects).filter((name) => name.includes(root.split("/").at(-1)!));
	check("Claude Code ran in each project's directory", ours.some((n) => n.endsWith("-one")) && ours.some((n) => n.endsWith("-two")), ours.join(", ") || "no session files under the projects' directories");

	// 2
	await ask(host, a.id, "Remember this for later: the backup on nas failed at 03:10 with exit code 23. Reply with just 'noted'.");
	const conversation = await host.conversation(a.id);
	const task = await conversation.compact(undefined, context);
	const compacted = await host.harness.waitForTask(task, context);
	await conversation.waitForIdle(context);
	const outcome = compacted.state.outcome;
	const summarized = outcome.status === "completed" && (outcome.result.entryId ?? outcome.result.submissionId) !== undefined;
	check("compaction summary from the bridge", summarized, JSON.stringify(outcome).slice(0, 200));
	const head = (await conversation.context(context)).head;
	check("the context starts at the summary", head?.kind === "pi.compaction", `head ${head?.kind}: ${JSON.stringify(head?.data ?? head?.model).slice(0, 300)}`);
	const recalled = await ask(host, a.id, "What exit code did the backup fail with, and at what time? One line.");
	check("after compaction the session still knows", /23/.test(recalled) && /3:10/.test(recalled), recalled);
	await host.close();

	// 3
	const crash = join(root, "crash");
	mkdirSync(crash);
	const child = spawn(process.execPath, ["--no-warnings", import.meta.filename, "--crash-child", data, crash], { stdio: "inherit" });
	while (!existsSync(join(crash, ".started"))) await new Promise((resolve) => setTimeout(resolve, 200));
	child.kill("SIGKILL");
	await new Promise((resolve) => child.once("exit", resolve));
	const crashed = Number(readFileSync(join(crash, ".started"), "utf8"));
	host = await openHost({ config: config(data), onNotice: (n) => notices.push(n.message) });
	host.resume();
	await (await host.conversation(crashed)).waitForIdle(context);
	const notes = existsSync(join(crash, "notes.txt")) ? readFileSync(join(crash, "notes.txt"), "utf8") : "(no notes.txt)";
	const finalAnswer = await answer(host, crashed);
	check("after kill -9 the run finished its steps", /step2/.test(notes), `notes.txt: ${JSON.stringify(notes)}; answer: ${finalAnswer}`);
	await host.close();
} catch (error) {
	check("live check", false, error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
	const ccProjects = join(homedir(), ".claude", "projects");
	for (const name of readdirSync(ccProjects).filter((n) => n.includes(root.split("/").at(-1)!))) rmSync(join(ccProjects, name), { recursive: true, force: true });
	rmSync(root, { recursive: true, force: true });
}
if (notices.length > 0) console.log(`bridge notices:\n  ${notices.join("\n  ")}`);
const failed = results.filter(([, ok]) => !ok).length;
console.log(failed === 0 ? "\nAll live checks passed." : `\n${failed} live check${failed === 1 ? "" : "s"} failed.`);
process.exit(failed === 0 ? 0 : 1);
