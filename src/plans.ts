// A project's plan, docs/plan.md, read from its working copy for read_plan over MCP (src/mcp.ts) and projects.plan on
// /amyrlin (its items, for an app's list of what to start), so an agent on
// another machine (Verin's Plans) sees the plan as it is on this one, unpushed edits included. Only that one file: a
// docs or docs/plan.md that's a symbolic link, or resolves outside the project, isn't followed, and a plan over
// MAX_PLAN bytes is refused rather than cut, since half a plan reads as a whole one.
//
// writePlan replaces it for write_plan, under the same rules: only a plan in the standard format (checkPlan) that keeps
// every id the file had, only when the caller's `base` is the sha256 of the file as it is, and atomically, a temporary
// file in docs/ renamed over it. Writes to one project are serialized here, so two calls can't interleave. It writes
// the working copy only, never the index or a commit.
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
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

/** The sha256 of a plan's text as UTF-8, in hex: what read_plan answers and write_plan takes as `base`. */
export function planSha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The kinds an item's status line may name. */
export const PLAN_KINDS = ["step", "question", "request", "chore"] as const;

type Heading = { line: number; level: number; text: string; next: string | undefined };

/** Every Markdown heading outside fenced code, with its line number (from 1) and the line after it. */
function headings(lines: readonly string[]): Heading[] {
	const found: Heading[] = [];
	let fence: string | undefined;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const mark = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
		if (mark !== undefined) {
			if (fence === undefined) fence = mark[0]!;
			else if (mark[0] === fence) fence = undefined;
			continue;
		}
		if (fence !== undefined) continue;
		const heading = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
		if (heading !== null) found.push({ line: i + 1, level: heading[1]!.length, text: heading[2]!, next: lines[i + 1] });
	}
	return found;
}

/**
 * What's wrong with `text` as a plan in the standard format, every problem in a line, or [] when it's fine: exactly the
 * five `##` sections in order; every `###` heading `<id>: <title>` with a unique id matching PLAN_ITEM_ID, under a
 * section, the line under it a status line starting `Kind:` with one of PLAN_KINDS; every bare id in `Needs` an item
 * here (`<repo>/<id>` isn't checked); and at most MAX_PLAN bytes. With `previous`, the file it replaces, no item id
 * `previous` has may be missing, since other repos link to them: a dropped item moves to Done saying why.
 */
export function checkPlan(text: string, previous?: string): string[] {
	const problems: string[] = [];
	const size = Buffer.byteLength(text, "utf8");
	if (size > MAX_PLAN) problems.push(`it's ${size} bytes, over the ${MAX_PLAN} a plan may be`);
	const found = headings(text.split(/\r?\n/));
	const sections = found.filter((h) => h.level === 2);
	const names = sections.map((h) => h.text);
	if (names.length !== PLAN_SECTIONS.length || names.some((n, i) => n !== PLAN_SECTIONS[i])) {
		problems.push(`its ## sections are ${names.length === 0 ? "none" : names.map((n) => `"${n}"`).join(", ")}; a plan has exactly ${PLAN_SECTIONS.join(", ")}, in that order, each once (an empty one stays, with nothing under it)`);
	}
	const ids = new Map<string, number>();
	const needs: { id: string; need: string; line: number }[] = [];
	let inSection = false;
	for (const h of found) {
		if (h.level <= 2) {
			inSection = h.level === 2;
			continue;
		}
		if (h.level !== 3) continue;
		const where = `line ${h.line}`;
		if (!inSection) problems.push(`${where}: "### ${h.text}" isn't under one of the ## sections`);
		const item = /^([^:\s]+):\s+(\S.*)$/.exec(h.text);
		if (item === null || !PLAN_ITEM_ID.test(item[1]!)) {
			problems.push(`${where}: "### ${h.text}" isn't "<id>: <title>" with an id of lowercase letters, digits and -, starting with a letter or digit, at most 80 characters`);
			continue;
		}
		const id = item[1]!;
		const first = ids.get(id);
		if (first !== undefined) problems.push(`${where}: id ${id} is used already, on line ${first}; ids are unique`);
		else ids.set(id, h.line);
		const status = h.next ?? "";
		if (!status.startsWith("Kind:")) {
			problems.push(`${where}: the line under ${id}'s heading is its status line and starts with "Kind: <${PLAN_KINDS.join(", ")}>"`);
			continue;
		}
		const fields = status.split(" · ");
		const kind = /^Kind:\s*(.*?)\s*$/.exec(fields[0]!)?.[1] ?? "";
		if (!(PLAN_KINDS as readonly string[]).includes(kind)) problems.push(`line ${h.line + 1}: ${id}'s Kind is "${kind}"; it's one of ${PLAN_KINDS.join(", ")}`);
		for (const field of fields.slice(1)) {
			const [, name, value] = /^\s*([A-Za-z]+):\s*(.*?)\s*$/.exec(field) ?? [];
			if (name !== "Needs" || value === undefined) continue;
			for (const need of value.split(",").map((n) => n.trim()).filter((n) => n !== "")) needs.push({ id, need, line: h.line + 1 });
		}
	}
	for (const { id, need, line } of needs) {
		if (!need.includes("/") && !ids.has(need)) problems.push(`line ${line}: ${id} needs ${need}, which isn't an item in this plan; name one here, or <repo>/<id> for another repo's`);
	}
	if (previous !== undefined) {
		const gone = planItems(previous).map((i) => i.id).filter((id, i, all) => all.indexOf(id) === i && !ids.has(id));
		if (gone.length > 0) problems.push(`${gone.length === 1 ? "item" : "items"} ${gone.join(", ")} ${gone.length === 1 ? "is" : "are"} missing; an id is never removed, since other repos and Verin link to <repo>/<id>. Move a dropped item to Done with a line saying why`);
	}
	return problems;
}

/** Each item's section and its text from heading to the next heading of its level or above, by id, for comparing. */
function itemBlocks(text: string): Map<string, { section: PlanSection; text: string }> {
	const lines = text.split(/\r?\n/);
	const found = headings(lines);
	const items = new Map(planItems(text).map((item) => [item.id, item]));
	const blocks = new Map<string, { section: PlanSection; text: string }>();
	for (let i = 0; i < found.length; i++) {
		const h = found[i]!;
		const id = h.level === 3 ? /^([^:\s]+):/.exec(h.text)?.[1] : undefined;
		const item = id === undefined ? undefined : items.get(id);
		if (item === undefined || blocks.has(item.id)) continue;
		const end = found.slice(i + 1).find((n) => n.level <= 3)?.line ?? lines.length + 1;
		blocks.set(item.id, { section: item.section, text: lines.slice(h.line - 1, end - 1).join("\n").trimEnd() });
	}
	return blocks;
}

/**
 * Which items a write changed, by id, in the new file's order: added and removed, moved to another section, and
 * changed in their heading, status line or prose without moving. An item that moved and changed is only in moved.
 */
export function planChanges(previous: string, next: string): { added: string[]; removed: string[]; moved: string[]; changed: string[] } {
	const before = itemBlocks(previous);
	const after = itemBlocks(next);
	const changes = { added: [] as string[], removed: [...before.keys()].filter((id) => !after.has(id)), moved: [] as string[], changed: [] as string[] };
	for (const [id, block] of after) {
		const old = before.get(id);
		if (old === undefined) changes.added.push(id);
		else if (old.section !== block.section) changes.moved.push(id);
		else if (old.text !== block.text) changes.changed.push(id);
	}
	return changes;
}

/** A write refused because the plan isn't the one the caller read: nothing was written. */
export class PlanConflict extends Error {}
/** A write refused because the new text breaks the format's rules, every problem listed: nothing was written. */
export class PlanInvalid extends Error {
	readonly problems: string[];
	constructor(problems: string[]) {
		super(`The plan wasn't written. Fix ${problems.length === 1 ? "this" : `these ${problems.length}`} and call again with the same base:\n${problems.map((p) => `- ${p}`).join("\n")}`);
		this.problems = problems;
	}
}

export type PlanWrite = { project: string; path: string; sha256: string; size: number; modified: string; items: ReturnType<typeof planChanges> };

/** Each project's latest write, by directory, so the next waits for it. */
const writing = new Map<string, Promise<unknown>>();

/**
 * Replaces `project`'s docs/plan.md with `text` when `base` is the sha256 of the file now, or `base` is null and there
 * is none. Throws PlanConflict when it isn't, PlanInvalid when checkPlan finds problems, and an Error for a plan it
 * won't touch: a symbolic link, outside the project, not a file. Makes docs/ when it's missing, keeps the file's mode,
 * and never writes the index or a commit.
 */
export async function writePlan(project: Pick<Project, "name" | "dir">, text: string, base: string | null): Promise<PlanWrite> {
	const root = await realpath(project.dir);
	const prior = writing.get(root) ?? Promise.resolve();
	const run = prior.catch(() => undefined).then(() => writeNow(project, root, text, base));
	writing.set(root, run);
	try {
		return await run;
	} finally {
		if (writing.get(root) === run) writing.delete(root);
	}
}

/** The plan now, for a write: readPlan's answer, with base checked against it. */
async function current(project: Pick<Project, "name" | "dir">, base: string | null): Promise<Plan> {
	const plan = await readPlan(project);
	if (base === null && plan.exists) throw new PlanConflict(`${project.name} has a ${PLAN_PATH} now, and base null only makes one where there's none. Nothing was written: read_plan it, make your edit to that text, and pass its sha256 as base`);
	if (base !== null && !plan.exists) throw new PlanConflict(`${project.name}'s ${PLAN_PATH} is gone since it was read. Nothing was written: read_plan it again, and pass base null to make one`);
	if (base !== null && plan.exists && plan.sha256 !== base) throw new PlanConflict(`${project.name}'s ${PLAN_PATH} changed since it was read (base ${base.slice(0, 12)}…, now ${plan.sha256.slice(0, 12)}…). Nothing was written: read_plan it again, make your edit to that text, and pass its sha256 as base`);
	return plan;
}

const inside = (root: string, path: string) => {
	const rel = relative(root, path);
	return !rel.startsWith("..") && !isAbsolute(rel);
};

async function writeNow(project: Pick<Project, "name" | "dir">, root: string, text: string, base: string | null): Promise<PlanWrite> {
	const docs = join(project.dir, "docs");
	const file = join(project.dir, PLAN_PATH);
	const before = await current(project, base);
	const problems = checkPlan(text, before.exists ? before.text : undefined);
	if (problems.length > 0) throw new PlanInvalid(problems);
	let mode = 0o644;
	if (before.exists) mode = (await lstat(file)).mode & 0o7777;
	else {
		try {
			await mkdir(docs);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}
	const docsStat = await lstat(docs);
	if (docsStat.isSymbolicLink()) throw new Error(`${project.name}'s docs is a symbolic link, which write_plan doesn't follow`);
	if (!docsStat.isDirectory()) throw new Error(`${project.name}'s docs isn't a directory`);
	if (!inside(root, await realpath(docs))) throw new Error(`${project.name}'s docs isn't inside the project`);
	const temp = join(docs, `.plan.md.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
	const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
	let renamed = false;
	try {
		try {
			await handle.writeFile(text, "utf8");
			// The mode at create is masked by the umask; the existing file's is kept exactly.
			if (before.exists) await handle.chmod(mode);
			await handle.sync();
		} finally {
			await handle.close();
		}
		// Again just before the rename, for an edit made outside the host meanwhile, and a docs swapped for a link.
		await current(project, base);
		const again = await lstat(docs);
		if (again.isSymbolicLink() || again.ino !== docsStat.ino) throw new Error(`${project.name}'s docs changed while the plan was written; nothing was written`);
		await rename(temp, file);
		renamed = true;
	} finally {
		if (!renamed) await unlink(temp).catch(() => undefined);
	}
	// The rename itself, made durable.
	const dir = await open(docs, constants.O_RDONLY | constants.O_DIRECTORY);
	try {
		await dir.sync();
	} catch {
		// Not every file system lets a directory be synced.
	} finally {
		await dir.close();
	}
	const stat = await lstat(file);
	return {
		project: project.name,
		path: PLAN_PATH,
		sha256: planSha256(text),
		size: Buffer.byteLength(text, "utf8"),
		modified: stat.mtime.toISOString(),
		items: planChanges(before.exists ? before.text : "", text),
	};
}
