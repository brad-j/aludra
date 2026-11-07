// The project's context in the system prompt: AGENTS.md or CLAUDE.md files and skills, found the way terminal pi finds
// them (pi-coding-agent's own loaders): ~/.pi/agent/AGENTS.md, then each directory from / down to the project's, and
// skills from ~/.pi/agent/skills and the project's .pi/skills. They're read again before every request, so an edit
// reaches the next one; Pi Durable sends a section again only when it changed.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { formatSkillsForPrompt, loadProjectContextFiles, loadSkills, type Skill, stripFrontmatter } from "@earendil-works/pi-coding-agent";
import { defineExtension, type PromptInput, section } from "@earendil-works/pi-durable";

export const AGENT_DIR = join(homedir(), ".pi", "agent");

export function projectContext(cwd: string, agentDir = AGENT_DIR): string | undefined {
	const files = loadProjectContextFiles({ cwd, agentDir });
	if (files.length === 0) return undefined;
	const blocks = files.map(({ path, content }) => `<project_instructions path="${path}">\n${content}\n</project_instructions>\n\n`);
	return `<project_context>\n\nProject-specific instructions and guidelines:\n\n${blocks.join("")}</project_context>`;
}

/**
 * A skill a session can load: the agent directory's (`user`) or the project's `.pi/skills` (`project`). `filePath` and
 * `baseDir` are where the agent reads it, which for a sandbox session are its copies in the VM.
 */
export type SkillInfo = { name: string; description: string; filePath: string; baseDir: string; source: "user" | "project" };

const infoOf = (skill: Skill): SkillInfo => ({ name: skill.name, description: skill.description, filePath: skill.filePath, baseDir: skill.baseDir, source: skill.sourceInfo.scope === "project" ? "project" : "user" });

/**
 * The skills a session in `cwd` is told about, in the prompt's order: the agent directory's, then the project's, with
 * pi's own loader, so a project skill named like a user skill loses. Without `cwd`, the user's alone. Skills marked
 * `disable-model-invocation` are left out, as the prompt leaves them out. The one source for the prompt, the copy into a
 * sandbox, host.info and `/skill:` expansion.
 */
export function skillsFor(cwd: string | undefined, agentDir = AGENT_DIR): SkillInfo[] {
	const loaded = cwd === undefined
		? loadSkills({ cwd: agentDir, agentDir, skillPaths: [join(agentDir, "skills")], includeDefaults: false }).skills
		: loadSkills({ cwd, agentDir, skillPaths: [], includeDefaults: true }).skills;
	return loaded.filter((s) => !s.disableModelInvocation).map(infoOf);
}

/**
 * Project `dir`'s own skills as `skillsFor` would list them beside `user`, the user's: its `.pi/skills`, less any named
 * like a user skill, which wins. For host.info, which lists the user's once and then each project's.
 */
export function projectSkills(dir: string, user: readonly SkillInfo[], agentDir = AGENT_DIR): SkillInfo[] {
	const skillsDir = join(dir, ".pi", "skills");
	if (!existsSync(skillsDir)) return [];
	const names = new Set(user.map((s) => s.name));
	return loadSkills({ cwd: dir, agentDir, skillPaths: [skillsDir], includeDefaults: false }).skills
		.filter((s) => !s.disableModelInvocation && !names.has(s.name))
		.map((s) => ({ ...infoOf(s), source: "project" as const }));
}

/** The skills section for `list`, or undefined when it's empty. */
export function skillsSection(list: readonly SkillInfo[]): string | undefined {
	const asSkills = list.map((s): Skill => ({ ...s, disableModelInvocation: false, sourceInfo: { path: s.filePath, source: "local", scope: s.source, origin: "top-level", baseDir: s.baseDir } }));
	return formatSkillsForPrompt(asSkills, "read").trim() || undefined;
}

export function skills(cwd: string, agentDir = AGENT_DIR): string | undefined {
	return skillsSection(skillsFor(cwd, agentDir));
}

/**
 * `text` with a leading `/skill:<name> args` replaced by the skill's file, as terminal pi's AgentSession expands it: a
 * `<skill name location>` block, then the arguments. `read` gets the file from where the agent would (a sandbox session's
 * through its sandbox). An unknown name, or a file that can't be read, leaves the text as it was.
 */
export async function expandSkill(text: string, list: readonly SkillInfo[], read: (path: string) => Promise<string | undefined>): Promise<string> {
	if (!text.startsWith("/skill:")) return text;
	const space = text.search(/\s/);
	const name = space === -1 ? text.slice(7) : text.slice(7, space);
	const args = space === -1 ? "" : text.slice(space + 1).trim();
	const skill = list.find((s) => s.name === name);
	if (skill === undefined) return text;
	const content = await read(skill.filePath).catch(() => undefined);
	if (content === undefined) return text;
	const block = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${stripFrontmatter(content).trim()}\n</skill>`;
	return args === "" ? block : `${block}\n\n${args}`;
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
export function sandboxSection(sandbox: { sandbox: number; dir: string; scratch?: boolean }): string {
	return [
		`This session runs in a sandbox: a disposable Linux VM of its own (Ubuntu 26.04, user \`user\` with sudo), sandbox ${sandbox.sandbox}.`,
		...(sandbox.scratch === true ? [`It's scratch work, in no project: ${sandbox.dir} is a git repository with one empty commit on main. Commit as you go, so the user can see the work and keep it; there's nowhere to ship it, but the user can make it a project of its own from the app.`] : []),
		`Your tools run there, and your working directory is ${sandbox.dir} in the sandbox. Any other working directory or machine named elsewhere in this prompt is where the agent loop runs, which your tools can't reach.`,
		"The sandbox reaches the internet and nothing else: not the LAN, not the tailnet, not other machines at home. It has no credentials: it can't push, and git remotes are unset. Commit your work as you go: your commits come home by themselves as a branch in the user's checkout when your reply ends, and the user lands them with Ship in their app. So never tell them to fetch, push, merge or copy anything.",
		"A process started with `setsid` outlives your command and keeps running while the sandbox is paused between turns; anything else you start ends with the command.",
	].join("\n");
}

/**
 * How a session reports its work (src/results.ts), in every session's prompt, on this machine or in a sandbox: a plan
 * kept as a `plan` block while the work goes on, and a `result` block with a question when it stops to ask. The app
 * shows the answer's prose; summary, changes and headsUp are no longer asked for, though results.ts still reads them.
 */
export const RESULT_INSTRUCTIONS = [
	"The app reads two fenced blocks from your replies and hides them from the conversation, so write your answer as usual around them.",
	"While you work on anything with more than one step, keep a plan: a ```plan block with a Markdown checklist (`- [ ] step`, `- [x] done`), in plain words. Write it before you start and write it again, whole, each time a step is done or the plan changes.",
	"When you stop to ask the user something, end the reply with a ```result block holding one JSON object:",
	"```result",
	'{"question": {"text": "What you need them to decide.", "why": "Why it matters.", "options": ["First choice", "Second choice"]}}',
	"```",
	"Its options become buttons that send the option's text as the reply, so make each one a complete answer. Leave the block out when you aren't asking anything.",
];

/**
 * The project's AGENTS.md and skills (a sandbox session's from its copies), the no-project section, a sandbox session's own section, and the result
 * instructions, which every session gets. `sandboxOf` tells a sandbox
 * session's sandbox and the local checkout its project context is read from (the sandbox's copy is at the same commit).
 */
export function contextExtension(agentDir = AGENT_DIR, noProject?: { scratchRoot: string; places: () => readonly Place[] }, sandboxOf?: (input: PromptInput) => Promise<{ sandbox: number; dir: string; local?: string; skills?: readonly SkillInfo[] } | undefined>) {
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
			// Every session, a project's or not, on this machine or in a sandbox: task.result reads the plan and the question
			// from any conversation, and a question's options are as useful without a project.
			section("results", () => RESULT_INSTRUCTIONS.join("\n")),
			section("no_project", ({ agent }) => (inScratch(agent.cwd) ? noProjectSection(agent.cwd!, noProject!.places()) : undefined)),
			section("project_context", async (input) => {
				const dir = await contextDir(input);
				return dir === undefined ? undefined : projectContext(dir, agentDir);
			}, { tag: false }),
			section("skills", async (input) => {
				// A sandbox session's are the copies made with its sandbox, at their paths there; none when the copy failed, or
				// for a sandbox from before the copies, whose host paths the agent couldn't read.
				const sandbox = await sandboxOf?.(input);
				if (sandbox !== undefined) return skillsSection(sandbox.skills ?? []);
				const dir = await contextDir(input);
				return dir === undefined ? undefined : skills(dir, agentDir);
			}, { tag: false }),
		],
	});
}
