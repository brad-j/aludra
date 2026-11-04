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

/** Where an orb session (spike) runs, said to it in its system prompt; Claude Code names the host's directory otherwise. */
export function orbSection(orb: { orb: number; dir: string }): string {
	return [
		`This session runs in an orb: a disposable Linux VM of its own (Ubuntu 26.04, user \`user\` with sudo), orb ${orb.orb}.`,
		`Your tools run there, and your working directory is ${orb.dir} in the orb. Any other working directory or machine named elsewhere in this prompt is where the agent loop runs, which your tools can't reach.`,
		"The orb reaches the internet and nothing else: not the LAN, not the tailnet, not other machines at home. It has no credentials: it can't push, and git remotes are unset. The project's commits stay in the orb until the user fetches them.",
		"A process started with `setsid` outlives your command and keeps running while the orb is paused between turns; anything else you start ends with the command.",
	].join("\n");
}

/**
 * The project's AGENTS.md and skills, the no-project section, and an orb session's own section. `orbOf` tells an orb
 * session's orb and the local checkout its project context is read from (the orb's copy is at the same commit).
 */
export function contextExtension(agentDir = AGENT_DIR, noProject?: { scratchRoot: string; places: () => readonly Place[] }, orbOf?: (input: PromptInput) => Promise<{ orb: number; dir: string; local?: string } | undefined>) {
	const inScratch = (cwd: string | undefined) => noProject !== undefined && cwd !== undefined && cwd.startsWith(noProject.scratchRoot + "/");
	/** Where this session's project context is read: its own directory, or an orb session's local checkout. */
	const contextDir = async (input: PromptInput): Promise<string | undefined> => {
		const orb = await orbOf?.(input);
		if (orb !== undefined) return orb.local ?? agentDir;
		return input.agent.cwd;
	};
	return defineExtension({
		name: "project-context",
		sections: [
			section("orb", async (input) => {
				const orb = await orbOf?.(input);
				return orb === undefined ? undefined : orbSection(orb);
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
