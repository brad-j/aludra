// Skills in a sandbox: when a sandbox is made, the skills its session would get here (src/context.ts, skillsFor) are
// copied in, the user's to `<home>/.pi/agent/skills` (Claude Code's to `<home>/.claude/skills`) and the project's to
// `<home>/.aludra/project-skills`, outside the repository so they never show as uncommitted work. The list kept on the session names the copies, so the prompt,
// host.info's sandbox.skills and `/skill:` expansion all name files the agent can read. No live sync.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { BACKGROUND_CONTEXT as BACKGROUND } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { SkillInfo } from "./context.ts";

/** The most the copies may come to, as a tar. */
export const MAX_SKILL_BYTES = 20 * 1024 * 1024;

/** Where a sandbox keeps the copies, under its home directory. */
export const userSkillsIn = (home: string) => `${home}/.pi/agent/skills`;
export const claudeSkillsIn = (home: string) => `${home}/.claude/skills`;
export const projectSkillsIn = (home: string) => `${home}/.aludra/project-skills`;

const tar = (args: string[]) => new Promise<void>((done, fail) => execFile("tar", args, { maxBuffer: 1024 * 1024 }, (error, _out, err) => (error === null ? done() : fail(new Error(`tar: ${err.trim() || error.message}`)))));

/**
 * The top-level entries of `local` the skills live under, each as `./<name>`, for tar; entries whose links lead nowhere
 * are left out, since no skill can be in them.
 */
async function skillDirs(local: string, skills: readonly SkillInfo[]): Promise<string[]> {
	const wanted = new Set(skills.map((s) => relative(local, resolve(s.filePath)).split(/[/\\]/)[0]!).filter((name) => name !== "" && name !== ".."));
	const present: string[] = [];
	for (const name of (await readdir(local)).sort()) {
		if (!wanted.has(name)) continue;
		if (await stat(join(local, name)).then(() => true, () => false)) present.push(`./${name}`);
	}
	return present;
}

/**
 * Copies `skills`, as `skillsFor` found them here under `userDir` (the agent directory's skills/), `claudeDir` (Claude
 * Code's skills/) and `projectDir` (the project's .pi/skills), into the sandbox `env` under `home`, links followed, and
 * returns them with the paths there. Throws when a copy is over MAX_SKILL_BYTES or tar or the transfer fails; the caller
 * leaves the skills out then.
 */
export async function copySkills(env: ExecutionEnv, skills: readonly SkillInfo[], from: { userDir: string; claudeDir?: string; projectDir?: string }, home: string): Promise<SkillInfo[]> {
	const under = (dir: string) => (s: SkillInfo) => !relative(dir, resolve(s.filePath)).startsWith("..");
	const roots = [
		{ name: "user", local: resolve(from.userDir), remote: userSkillsIn(home), mine: (s: SkillInfo) => s.source === "user" && under(resolve(from.userDir))(s) },
		...(from.claudeDir === undefined ? [] : [{ name: "claude", local: resolve(from.claudeDir), remote: claudeSkillsIn(home), mine: (s: SkillInfo) => s.source === "user" && under(resolve(from.claudeDir!))(s) }]),
		...(from.projectDir === undefined ? [] : [{ name: "project", local: resolve(from.projectDir), remote: projectSkillsIn(home), mine: (s: SkillInfo) => s.source === "project" }]),
	];
	const copied: SkillInfo[] = [];
	const scratch = await mkdtemp(join(tmpdir(), "aludra-skills-"));
	try {
		let total = 0;
		for (const root of roots) {
			// A skill is copied once, from the first root it's under.
			const mine = skills.filter((s) => root.mine(s) && !copied.some((c) => c.name === s.name));
			if (mine.length === 0) continue;
			const file = join(scratch, `${root.name}.tar`);
			// Only the skills' own directories, so a link in the skills directory that leads nowhere (a skill whose repository
			// moved) doesn't fail the whole copy: tar -h would stop at it.
			const dirs = await skillDirs(root.local, mine);
			await tar(["-chf", file, "-C", root.local, ...dirs]);
			const bytes = await readFile(file);
			total += bytes.length;
			if (total > MAX_SKILL_BYTES) throw new Error(`the skills come to over ${MAX_SKILL_BYTES / 1024 / 1024} MB`);
			const remoteTar = `/tmp/aludra-skills-${randomUUID()}.tar`;
			const put = await env.writeFile(remoteTar, bytes, BACKGROUND);
			if (!put.ok) throw put.error;
			let out = "";
			const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
			const ran = await env.exec(["bash", "-c", `set -e; rm -rf ${q(root.remote)}; mkdir -p ${q(root.remote)}; tar -xf ${q(remoteTar)} -C ${q(root.remote)}; rm -f ${q(remoteTar)}`], { onOutput: (t) => (out += t), timeout: 60_000 }, BACKGROUND);
			if (!ran.ok) throw ran.error;
			if (ran.value.exitCode !== 0) throw new Error(`unpacking the ${root.name} skills failed: ${out.trim().slice(-500)}`);
			for (const skill of mine) {
				const moved = (path: string) => {
					const rel = relative(root.local, resolve(path));
					if (rel.startsWith("..")) throw new Error(`${path} isn't under ${root.local}`);
					return rel === "" ? root.remote : `${root.remote}/${rel.split("\\").join("/")}`;
				};
				copied.push({ ...skill, filePath: moved(skill.filePath), baseDir: moved(skill.baseDir) });
			}
		}
		// In the prompt's order, whatever order the roots were copied in.
		return skills.flatMap((s) => copied.filter((c) => c.name === s.name));
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}
