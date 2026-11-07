// Live check of skills in a sandbox, run by hand on a machine with a sandbox host and Claude Code: makes one sandbox
// session for PROJECT_DIR with the user's real skills (~/.pi/agent/skills) and the project's, has the agent read a
// copied skill file through its prompt's listing, then sends `/skill:<name>` and has it say what it was given. The host
// runs in a temp data directory, and the sandbox is deleted at the end.
//
//   node --no-warnings scripts/skills-check.ts SANDBOX_HOST_JSON PROJECT_DIR [SKILL]
//
// SKILL defaults to the first skill copied in.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { configFor } from "../src/config.ts";
import { context, openHost, type Host } from "../src/host.ts";
import { describeAnswer } from "../src/server.ts";

const [hostFile, projectDir, wanted] = process.argv.slice(2);
if (hostFile === undefined || projectDir === undefined) throw new Error("usage: skills-check.ts SANDBOX_HOST_JSON PROJECT_DIR [SKILL]");
const root = mkdtempSync(join(tmpdir(), "aludra-skills-"));
const config = configFor(JSON.stringify({ dataDir: join(root, "data"), workspaces: [{ name: "x", roots: [] }], model: { thinking: "low" }, sandboxes: JSON.parse(readFileSync(hostFile, "utf8")) }), {}).config;
const project = { workspace: "x", name: basename(projectDir), path: `${basename(dirname(projectDir))}/${basename(projectDir)}`, dir: projectDir };

async function turn(host: Host, id: number, text: string): Promise<string> {
	const settled = await (await host.submit(id, text)).wait(context);
	const entries = (await (await host.conversation(id)).context(context)).entries;
	const answer = describeAnswer(entries.at(-1)) ?? "(none)";
	console.log(`  turn ${settled.status}:\n  ${answer.replaceAll("\n", "\n  ")}`);
	return answer;
}

const host = await openHost({ config });
host.resume();
let sandbox: number | undefined;
let failed = false;
try {
	const session = await host.sessions.createSandbox(project, "skills check");
	sandbox = session.sandbox;
	const copied = (await host.sessions.get(session.id))?.sandboxSkills ?? [];
	console.log(`sandbox ${sandbox}: ${copied.length} skills copied`);
	for (const s of copied) console.log(`  ${s.source} ${s.name} ${s.filePath}`);
	const skill = copied.find((s) => s.name === (wanted ?? copied[0]?.name));
	if (skill === undefined) throw new Error(wanted === undefined ? "no skills were copied" : `${wanted} wasn't copied`);

	// 1. From the prompt's listing: the agent finds the location itself and reads it with its tools.
	const read = await turn(host, session.id, `Your instructions list a skill named ${skill.name}. Without searching the disk, take its location from your instructions, read that file with your read tool, and reply with two lines: the location you read, and the file's first line after its frontmatter. If the read fails, say so and quote the error.`);
	const readOk = read.includes(skill.filePath) && !/no such file|ENOENT|fail/i.test(read);
	console.log(`read from the listing: ${readOk ? "ok" : "CHECK BY EYE"}`);

	// 2. /skill: expansion, as loial's picker sends it.
	const expanded = await turn(host, session.id, `/skill:${skill.name} Reply only with the location attribute of the skill block at the top of this message.`);
	const expandedOk = expanded.includes(skill.filePath);
	console.log(`/skill: expanded to the sandbox's copy: ${expandedOk ? "ok" : "CHECK BY EYE"}`);
	failed = !readOk || !expandedOk;
} finally {
	if (sandbox !== undefined) await host.sandboxes.remove(sandbox).catch((error) => console.error(`removing sandbox ${sandbox}: ${error.message}`));
	await host.close();
	rmSync(root, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
