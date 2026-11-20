// What a new project's first commit holds besides its README (plan: starter-files): AGENTS.md for any agent that works
// in it, a CLAUDE.md that points Claude Code at AGENTS.md, and docs/plan.md in the standard plan format (src/plans.ts
// reads it back for projects.plan), seeded with the steps and questions a client gives. With `ui`, the design seeds
// DESIGN.md and PRODUCT.md are copied in from the folder `newProjects.designSeeds` names.
//
// The text lives here rather than being read from elsewhere, so any machine makes the same project with no other
// checkout. test/starters.test.ts checks the plan against the format's rules.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NewProjectRefused } from "./new-projects.ts";
import { PLAN_ITEM_ID, PLAN_PATH, PLAN_SECTIONS } from "./plans.ts";

/** What a client may seed a new project's plan with: steps to do and questions to settle, in order. */
export type PlanSeed = { steps?: string[]; questions?: string[] };

/** The most items, and the longest title, a seed may have; a plan is a starting point, not an import. */
const MAX_ITEMS = 40;
const MAX_TITLE = 200;

/** Checks a seed from the wire. Throws NewProjectRefused saying what's wrong. */
export function checkSeed(seed: unknown): PlanSeed | undefined {
	if (seed === undefined || seed === null) return undefined;
	if (typeof seed !== "object" || Array.isArray(seed)) throw new NewProjectRefused("plan should be { steps?, questions? }");
	const out: PlanSeed = {};
	for (const key of ["steps", "questions"] as const) {
		const list = (seed as Record<string, unknown>)[key];
		if (list === undefined || list === null) continue;
		if (!Array.isArray(list) || list.some((x) => typeof x !== "string")) throw new NewProjectRefused(`plan.${key} should be a list of text`);
		out[key] = (list as string[]).map((x) => x.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE)).filter((x) => x !== "");
	}
	if ((out.steps?.length ?? 0) + (out.questions?.length ?? 0) > MAX_ITEMS) throw new NewProjectRefused(`plan has more than ${MAX_ITEMS} items`);
	return out;
}

/** An item id from its title: lowercase words joined by -, short, unique among `taken`. */
export function itemId(title: string, taken: Set<string>): string {
	const words = title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean).slice(0, 5);
	let base = words.join("-").slice(0, 40).replace(/-+$/, "") || "item";
	if (!PLAN_ITEM_ID.test(base)) base = `item-${base}`.slice(0, 40).replace(/-+$/, "");
	let id = base;
	for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
	taken.add(id);
	return id;
}

/**
 * docs/plan.md for a new project: the five sections in order, the first step in Now and the rest in Next, and the
 * questions under Questions. Empty sections stay, as the format asks.
 */
export function planText(name: string, seed?: PlanSeed): string {
	const taken = new Set<string>();
	const item = (title: string, kind: "step" | "question") => `### ${itemId(title, taken)}: ${title}\nKind: ${kind}\n`;
	const steps = seed?.steps ?? [];
	const items: Record<(typeof PLAN_SECTIONS)[number], string[]> = { Now: [], Next: [], Questions: [], Later: [], Done: [] };
	steps.forEach((s, i) => items[i === 0 ? "Now" : "Next"].push(item(s, "step")));
	for (const q of seed?.questions ?? []) items.Questions.push(item(q, "question"));
	const sections = PLAN_SECTIONS.map((s) => [`## ${s}`, "", ...items[s].flatMap((text) => [text])].join("\n").replace(/\n+$/, ""));
	return `# Plan\n\n${name}'s open work. Each item is a \`### id: title\` heading with a status line under it; the section it sits in is its status. Finishing an item moves it to Done, with \`Done: <date>\` on its status line, in the same commit as the work. An id never changes once written.\n\n${sections.join("\n\n")}\n`;
}

/** AGENTS.md for a new project: what it is, and where its work is planned. */
export function agentsText(name: string, description?: string): string {
	const about = description?.trim();
	return [
		`# ${name}`,
		"",
		...(about ? [about, ""] : []),
		`- Open work is in [${PLAN_PATH}](${PLAN_PATH}): sections Now, Next, Questions, Later and Done, an item per \`### id: title\` heading with a \`Kind:\` line under it. Take the top item in Now unless asked otherwise. Finishing an item moves it to Done in the same commit as the work; new work found along the way becomes a new item.`,
		"- Record decisions and their reasons in the docs as they're made, not only in commit messages.",
		"- Run the project's checks before saying a change works, and say which ran.",
		"",
	].join("\n");
}

/** CLAUDE.md: Claude Code reads it, and it points at AGENTS.md so both agents follow one file. */
export const CLAUDE_TEXT = "@AGENTS.md\n";

export const DESIGN_SEEDS = ["DESIGN.md", "PRODUCT.md"] as const;

/** Why `dir` can't give design seeds, or undefined when it has both. */
export function seedsProblem(dir: string | undefined): string | undefined {
	if (dir === undefined) return "this host has no newProjects.designSeeds, so it can't start a UI project";
	const missing = DESIGN_SEEDS.filter((f) => !existsSync(join(dir, f)));
	return missing.length === 0 ? undefined : `newProjects.designSeeds (${dir}) has no ${missing.join(" or ")}`;
}

/** Writes the starter files into `dir`; the files written, relative to it, for `git add`. */
export async function writeStarters(dir: string, name: string, options: { description?: string; plan?: PlanSeed; designSeeds?: string; ui?: boolean }): Promise<string[]> {
	await mkdir(join(dir, "docs"), { recursive: true });
	await writeFile(join(dir, "AGENTS.md"), agentsText(name, options.description));
	await writeFile(join(dir, "CLAUDE.md"), CLAUDE_TEXT);
	await writeFile(join(dir, PLAN_PATH), planText(name, options.plan));
	const files = ["AGENTS.md", "CLAUDE.md", PLAN_PATH];
	if (options.ui === true) {
		const problem = seedsProblem(options.designSeeds);
		if (problem !== undefined) throw new NewProjectRefused(problem);
		for (const f of DESIGN_SEEDS) {
			await writeFile(join(dir, f), await readFile(join(options.designSeeds!, f)));
			files.push(f);
		}
	}
	return files;
}
