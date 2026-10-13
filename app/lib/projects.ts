// Projects for the drawer and the picker: each project's colour, and the picker's groups. The same rules as the amyrlin
// Mac app (its AmyrlinCore ProjectColor and ProjectCatalog), so a project is the same colour on the phone and the Mac.
import type { Bootstrap, SessionSummary } from "../../src/api-types.ts";

export type Project = Bootstrap["projects"][number];

/** OKLCH hues, ordered so neighbours differ. Red and amber are left out: they mean failed and waiting. */
const HUES = [300, 165, 50, 240, 330, 110, 190, 355, 265, 140, 215];

/** FNV-1a over the name's UTF-8, as the Mac app hashes it. */
export function hueIndex(name: string): number {
	let hash = 0xcbf29ce484222325n;
	for (const byte of new TextEncoder().encode(name)) {
		hash ^= BigInt(byte);
		hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
	}
	return Number(hash % BigInt(HUES.length));
}

/** The project name of no-project sessions (src/host.ts NO_PROJECT); they're grey, not a hue. */
export const NO_PROJECT = "no project";
/** What the picker and the new-session screen pass for "no project": the API takes an empty project. */
export const NO_PROJECT_PATH = "";

/** A project's colour, at one lightness and chroma for every project; grey for no project. */
export const projectColor = (name: string) => (name === NO_PROJECT ? "var(--color-ink-3)" : `oklch(80% 0.12 ${HUES[hueIndex(name)]})`);
/** A selected row's wash in the project's hue. */
export const projectWash = (name: string) => (name === NO_PROJECT ? "var(--color-paper-3)" : `oklch(25% 0.035 ${HUES[hueIndex(name)]})`);

export type Entry = { project: Project; sessions: number; lastActive?: number };
export type Group = { id: string; title: string; entries: Entry[] };

export const RECENT = "recent";
const RECENT_LIMIT = 8;

/** The folder a project sits in: the first part of its path, or its workspace. */
export function folderOf(project: Project): string {
	const parts = project.path.split("/");
	return parts.length > 1 ? parts[0]! : project.workspace;
}

function entries(projects: readonly Project[], sessions: readonly SessionSummary[]): Entry[] {
	return projects.map((project) => {
		const mine = sessions.filter((s) => s.dir === project.dir);
		return mine.length === 0 ? { project, sessions: 0 } : { project, sessions: mine.length, lastActive: Math.max(...mine.map((s) => s.updatedAt)) };
	});
}

const byName = (a: Entry, b: Entry) => a.project.name.toLowerCase().localeCompare(b.project.name.toLowerCase());

/** "Recent" (projects with sessions, newest first), then each folder, largest first. */
export function projectGroups(projects: readonly Project[], sessions: readonly SessionSummary[]): Group[] {
	const all = entries(projects, sessions);
	const recent = all.filter((e) => e.lastActive !== undefined).sort((a, b) => b.lastActive! - a.lastActive!).slice(0, RECENT_LIMIT);
	const folders = new Map<string, Entry[]>();
	for (const entry of all) folders.set(folderOf(entry.project), [...(folders.get(folderOf(entry.project)) ?? []), entry]);
	const groups = [...folders].map(([folder, list]) => ({ id: folder, title: folder, entries: list.sort(byName) }));
	groups.sort((a, b) => b.entries.length - a.entries.length || a.title.localeCompare(b.title));
	return recent.length === 0 ? groups : [{ id: RECENT, title: "Recent", entries: recent }, ...groups];
}

/** 3 when the name starts with the first word, 2 when it holds every word, 1 when the path does; undefined otherwise. */
function score(project: Project, words: readonly string[]): number | undefined {
	const name = project.name.toLowerCase();
	const hay = `${project.path} ${project.workspace}`.toLowerCase();
	if (!words.every((w) => name.includes(w) || hay.includes(w))) return undefined;
	if (name.startsWith(words[0]!)) return 3;
	return words.every((w) => name.includes(w)) ? 2 : 1;
}

/** Projects matching every word of `query`, grouped by folder, best first; nothing for an empty query. */
export function searchProjects(query: string, projects: readonly Project[], sessions: readonly SessionSummary[]): Group[] {
	const words = query.toLowerCase().split(/\s+/).filter((w) => w !== "");
	if (words.length === 0) return [];
	const folders = new Map<string, { entry: Entry; score: number }[]>();
	for (const entry of entries(projects, sessions)) {
		const s = score(entry.project, words);
		if (s === undefined) continue;
		const folder = folderOf(entry.project);
		folders.set(folder, [...(folders.get(folder) ?? []), { entry, score: s }]);
	}
	return [...folders]
		.map(([folder, list]) => {
			list.sort((a, b) => b.score - a.score || byName(a.entry, b.entry));
			return { group: { id: folder, title: folder, entries: list.map((m) => m.entry) }, best: list[0]!.score };
		})
		.sort((a, b) => b.best - a.best || a.group.title.localeCompare(b.group.title))
		.map((g) => g.group);
}
