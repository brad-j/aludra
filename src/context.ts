// The project's context in the system prompt: AGENTS.md or CLAUDE.md files and skills, found the way terminal pi finds
// them (pi-coding-agent's own loaders): ~/.pi/agent/AGENTS.md, then each directory from / down to the project's, and
// skills from ~/.pi/agent/skills and the project's .pi/skills. They're read again before every request, so an edit
// reaches the next one; Pi Durable sends a section again only when it changed.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { formatSkillsForPrompt, loadProjectContextFiles, loadSkills } from "@earendil-works/pi-coding-agent";
import { defineExtension, type PromptInput, section } from "@earendil-works/pi-durable";

export const AGENT_DIR = join(homedir(), ".pi", "agent");

export function projectContext(cwd: string, agentDir = AGENT_DIR): string | undefined {
	const files = loadProjectContextFiles({ cwd, agentDir });
	if (files.length === 0) return undefined;
	const blocks = files.map(({ path, content }) => `<project_instructions path="${path}">\n${content}\n</project_instructions>\n\n`);
	return `<project_context>\n\nProject-specific instructions and guidelines:\n\n${blocks.join("")}</project_context>`;
}

export function skills(cwd: string, agentDir = AGENT_DIR): string | undefined {
	const loaded = loadSkills({ cwd, agentDir, skillPaths: [], includeDefaults: true }).skills;
	return formatSkillsForPrompt(loaded, "read").trim() || undefined;
}

/** A place a no-project session may want to look, said to it in its system prompt. */
export type Place = { path: string; what: string };

/**
 * What a no-project session is told: it has no project, its directory is for its own files, and where things are on
 * this machine. Only places that exist are listed.
 */
export function noProjectSection(cwd: string, places: readonly Place[]): string {
	const lines = places.filter((p) => existsSync(p.path)).map((p) => `- ${p.path.replace(homedir(), "~")}: ${p.what}`);
	return [
		"This session isn't in a project. Its working directory is a scratch directory of its own, for any files you make; read anything else by absolute path.",
		`Scratch directory: ${cwd}`,
		...(lines.length === 0 ? [] : ["Useful places on this machine:", ...lines]),
	].join("\n");
}

/** Where a sandbox session (spike) runs, said to it in its system prompt; Claude Code names the host's directory otherwise. */
export function sandboxSection(sandbox: { sandbox: number; dir: string }): string {
	return [
		`This session runs in a sandbox: a disposable Linux VM of its own (Ubuntu 26.04, user \`user\` with sudo), sandbox ${sandbox.sandbox}.`,
		`Your tools run there, and your working directory is ${sandbox.dir} in the sandbox. Any other working directory or machine named elsewhere in this prompt is where the agent loop runs, which your tools can't reach.`,
		"The sandbox reaches the internet and nothing else: not the LAN, not the tailnet, not other machines at home. It has no credentials: it can't push, and git remotes are unset. Commit your work as you go: your commits come home by themselves as a branch in the user's checkout when your reply ends, and the user lands them with Ship in their app. So never tell them to fetch, push, merge or copy anything.",
		"A process started with `setsid` outlives your command and keeps running while the sandbox is paused between turns; anything else you start ends with the command.",
		"",
		...RESULT_INSTRUCTIONS,
	].join("\n");
}

/**
 * How a sandbox session reports its work (src/results.ts): the user judges it from a result page without reading the
 * code, so each reply ends with a `result` block, and a plan is kept as a `plan` block while the work goes on.
 */
export const RESULT_INSTRUCTIONS = [
	"The user judges your work from a result page, without reading the code. Two fenced blocks feed it; the app hides them from the conversation, so write your answer as usual around them.",
	"While you work on anything with more than one step, keep a plan: a ```plan block with a Markdown checklist (`- [ ] step`, `- [x] done`), in plain words. Write it before you start and write it again, whole, each time a step is done or the plan changes.",
	"End every reply with a ```result block holding one JSON object:",
	"```result",
	'{"summary": "One or two sentences of what you did, for someone who uses the project.", "changes": ["What is different now for someone using it, one sentence each."], "headsUp": [{"kind": "upstream | dependency | left | other", "text": "Something they should know, in plain words."}], "question": {"text": "What you need them to decide.", "why": "Why it matters.", "options": ["First choice", "Second choice"]}}',
	"```",
	"Write summary, changes and headsUp for someone who uses the project, not its code: what they'll see or can now do, not file names or functions. Leave changes empty when nothing changed for them. headsUp is for things about the work itself that they should know, not steps for them to take with git or the sandbox. headsUp kinds: upstream (the upstream changed what this touches), dependency (a package added, removed or upgraded), left (work left uncommitted in the sandbox), other. A check you didn't run isn't a heads-up; say so in your prose. Include question only when you stopped to ask something; its options become buttons that send the option's text as the reply, so make each one a complete answer.",
];

/**
 * The project's AGENTS.md and skills, the no-project section, and a sandbox session's own section. `sandboxOf` tells a sandbox
 * session's sandbox and the local checkout its project context is read from (the sandbox's copy is at the same commit).
 */
export function contextExtension(agentDir = AGENT_DIR, noProject?: { scratchRoot: string; places: () => readonly Place[] }, sandboxOf?: (input: PromptInput) => Promise<{ sandbox: number; dir: string; local?: string } | undefined>) {
	const inScratch = (cwd: string | undefined) => noProject !== undefined && cwd !== undefined && cwd.startsWith(noProject.scratchRoot + "/");
	/** Where this session's project context is read: its own directory, or a sandbox session's local checkout. */
	const contextDir = async (input: PromptInput): Promise<string | undefined> => {
		const sandbox = await sandboxOf?.(input);
		if (sandbox !== undefined) return sandbox.local ?? agentDir;
		return input.agent.cwd;
	};
	return defineExtension({
		name: "project-context",
		sections: [
			section("sandbox", async (input) => {
				const sandbox = await sandboxOf?.(input);
				return sandbox === undefined ? undefined : sandboxSection(sandbox);
			}),
			section("no_project", ({ agent }) => (inScratch(agent.cwd) ? noProjectSection(agent.cwd!, noProject!.places()) : undefined)),
			section("project_context", async (input) => {
				const dir = await contextDir(input);
				return dir === undefined ? undefined : projectContext(dir, agentDir);
			}, { tag: false }),
			section("skills", async (input) => {
				const dir = await contextDir(input);
				return dir === undefined ? undefined : skills(dir, agentDir);
			}, { tag: false }),
		],
	});
}
