// The project's context in the system prompt: AGENTS.md or CLAUDE.md files and skills, found the way terminal pi finds
// them (pi-coding-agent's own loaders): ~/.pi/agent/AGENTS.md, then each directory from / down to the project's, and
// skills from ~/.pi/agent/skills and the project's .pi/skills. They're read again before every request, so an edit
// reaches the next one; Pi Durable sends a section again only when it changed.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { formatSkillsForPrompt, loadProjectContextFiles, loadSkills } from "@earendil-works/pi-coding-agent";
import { defineExtension, section } from "@earendil-works/pi-durable";

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

export function contextExtension(agentDir = AGENT_DIR, noProject?: { scratchRoot: string; places: readonly Place[] }) {
	const inScratch = (cwd: string | undefined) => noProject !== undefined && cwd !== undefined && cwd.startsWith(noProject.scratchRoot + "/");
	return defineExtension({
		name: "project-context",
		sections: [
			section("no_project", ({ agent }) => (inScratch(agent.cwd) ? noProjectSection(agent.cwd!, noProject!.places) : undefined)),
			section("project_context", ({ agent }) => (agent.cwd === undefined ? undefined : projectContext(agent.cwd, agentDir)), { tag: false }),
			section("skills", ({ agent }) => (agent.cwd === undefined ? undefined : skills(agent.cwd, agentDir)), { tag: false }),
		],
	});
}
