// A project's plan, docs/plan.md, read from its working copy for read_plan over MCP (src/mcp.ts), so an agent on
// another machine (Verin's Plans) sees the plan as it is on this one, unpushed edits included. Only that one file: a
// docs or docs/plan.md that's a symbolic link, or resolves outside the project, isn't followed, and a plan over
// MAX_PLAN bytes is refused rather than cut, since half a plan reads as a whole one.
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import type { Project } from "./projects.ts";

export const PLAN_PATH = "docs/plan.md";
export const MAX_PLAN = 512 * 1024;

export type Plan =
	| { project: string; path: string; exists: true; text: string; size: number; modified: string }
	| { project: string; path: string; exists: false };

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR";

/** `project`'s docs/plan.md. Throws, saying why, for a plan it won't read; a project without one isn't an error. */
export async function readPlan(project: Pick<Project, "name" | "dir">): Promise<Plan> {
	const none: Plan = { project: project.name, path: PLAN_PATH, exists: false };
	const file = join(project.dir, PLAN_PATH);
	for (const part of [join(project.dir, "docs"), file]) {
		let stat;
		try {
			stat = await lstat(part);
		} catch (error) {
			if (missing(error)) return none;
			throw error;
		}
		if (stat.isSymbolicLink()) throw new Error(`${project.name}'s ${relative(project.dir, part)} is a symbolic link, which read_plan doesn't follow`);
	}
	const inside = relative(await realpath(project.dir), await realpath(file));
	if (inside.startsWith("..") || isAbsolute(inside)) throw new Error(`${project.name}'s ${PLAN_PATH} isn't inside the project`);
	// O_NOFOLLOW too, so a link swapped in after the checks above isn't followed either.
	const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = await handle.stat();
		if (!stat.isFile()) throw new Error(`${project.name}'s ${PLAN_PATH} isn't a file`);
		if (stat.size > MAX_PLAN) throw new Error(`${project.name}'s ${PLAN_PATH} is ${stat.size} bytes, over read_plan's ${MAX_PLAN}`);
		const text = await handle.readFile("utf8");
		return { project: project.name, path: PLAN_PATH, exists: true, text, size: Buffer.byteLength(text), modified: stat.mtime.toISOString() };
	} finally {
		await handle.close();
	}
}
