// A project's plan, docs/plan.md, read from its working copy for read_plan over MCP (src/mcp.ts) and projects.plan on
// /app (its items, for an app's list of what to start), so an agent on
// another machine sees the plan as it is on this one, unpushed edits included. Only that one file: a
// docs or docs/plan.md that's a symbolic link, or resolves outside the project, isn't followed, and a plan over
// MAX_PLAN bytes is refused rather than cut, since half a plan reads as a whole one. Nothing here writes it.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import type { Project } from "./projects.ts";

export const PLAN_PATH = "docs/plan.md";
export const MAX_PLAN = 512 * 1024;

export type Plan =
	| { project: string; path: string; exists: true; text: string; sha256: string; size: number; modified: string }
	| { project: string; path: string; exists: false };

export const PLAN_SECTIONS = ["Now", "Next", "Questions", "Later", "Done"] as const;
export type PlanSection = (typeof PLAN_SECTIONS)[number];
/** One item of a plan in the standard format: `### id: title` under a section, then its status line. */
export type PlanItem = { id: string; title: string; section: PlanSection; kind?: string; needs?: string[]; run?: string };

/** What an item's id looks like: lowercase kebab-case. */
export const PLAN_ITEM_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;

/**
 * The items of a plan in the standard format, in the file's order: each `### id: title` under `## Now`, `Next`,
 * `Questions`, `Later` or `Done`, with `Kind`, `Needs` and `Run` from the status line under it when it has one.
 * Headings in fenced code, under any other section, or without an id are left out, so a plan in another format has none.
 */
export function planItems(text: string): PlanItem[] {
	const items: PlanItem[] = [];
	let section: PlanSection | undefined;
	let fence: string | undefined;
	let awaiting: PlanItem | undefined;
	for (const line of text.split(/\r?\n/)) {
		const mark = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
		if (mark !== undefined) {
			if (fence === undefined) fence = mark[0]!;
			else if (mark[0] === fence) fence = undefined;
			awaiting = undefined;
			continue;
		}
		if (fence !== undefined) continue;
		const heading = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
		if (heading !== null) {
			awaiting = undefined;
			if (heading[1]!.length <= 2) section = heading[1]!.length === 2 ? PLAN_SECTIONS.find((s) => s === heading[2]) : undefined;
			const item = heading[1]!.length === 3 && section !== undefined ? /^([^:\s]+):\s+(.+)$/.exec(heading[2]!) : null;
			if (item !== null && PLAN_ITEM_ID.test(item[1]!)) items.push((awaiting = { id: item[1]!, title: item[2]!, section: section! }));
			continue;
		}
		if (awaiting === undefined || line.trim() === "") continue;
		// The first line of text under the heading is the status line, when it starts with Kind.
		const found = awaiting;
		awaiting = undefined;
		if (!line.trim().startsWith("Kind:")) continue;
		for (const field of line.split(" · ")) {
			const [, name, value] = /^\s*([A-Za-z]+):\s*(.*?)\s*$/.exec(field) ?? [];
			if (name === "Kind" && value) found.kind = value;
			if (name === "Run" && value) found.run = value;
			if (name === "Needs" && value) found.needs = value.split(",").map((n) => n.trim()).filter((n) => n !== "");
		}
	}
	return items;
}

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
		return { project: project.name, path: PLAN_PATH, exists: true, text, sha256: planSha256(text), size: Buffer.byteLength(text), modified: stat.mtime.toISOString() };
	} finally {
		await handle.close();
	}
}

/** The sha256 of a plan's text as UTF-8, in hex, as read_plan answers it. */
export function planSha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}
