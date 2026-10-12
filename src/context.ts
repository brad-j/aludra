// The project's context in the system prompt: AGENTS.md or CLAUDE.md files and skills, found the way terminal pi finds
// them (pi-coding-agent's own loaders): ~/.pi/agent/AGENTS.md, then each directory from / down to the project's, and
// skills from ~/.pi/agent/skills and the project's .pi/skills. They're read again before every request, so an edit
// reaches the next one; Pi Durable sends a section again only when it changed.
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

export function contextExtension(agentDir = AGENT_DIR) {
	return defineExtension({
		name: "project-context",
		sections: [
			section("project_context", ({ agent }) => (agent.cwd === undefined ? undefined : projectContext(agent.cwd, agentDir)), { tag: false }),
			section("skills", ({ agent }) => (agent.cwd === undefined ? undefined : skills(agent.cwd, agentDir)), { tag: false }),
		],
	});
}
