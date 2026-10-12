// Projects: each directory a workspace root's glob matches. Roots take `*` within a path segment, and match
// directories only, never hidden ones.
import { readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { expandHome, type Workspace } from "./config.ts";

export type Project = {
	workspace: string;
	/** The directory's name, which `--project` takes. */
	name: string;
	/** The parent's name and the name, which `--project` takes when two projects share a name. */
	path: string;
	dir: string;
};

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function segmentMatcher(segment: string): RegExp {
	const escaped = segment.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
	return new RegExp(`^${escaped.join("[^/]*")}$`);
}

/** The directories `pattern` matches, sorted. */
export function expandRoot(pattern: string): string[] {
	const absolute = resolve(expandHome(pattern));
	const [first, ...segments] = absolute.split(sep);
	let found = [first === "" ? sep : first!];
	for (const segment of segments) {
		if (segment === "") continue;
		if (!segment.includes("*")) {
			found = found.map((dir) => join(dir, segment)).filter(isDirectory);
			continue;
		}
		const matcher = segmentMatcher(segment);
		found = found.flatMap((dir) => {
			try {
				return readdirSync(dir, { withFileTypes: true })
					.filter((entry) => !entry.name.startsWith(".") && matcher.test(entry.name))
					.map((entry) => join(dir, entry.name))
					.filter(isDirectory);
			} catch {
				return [];
			}
		});
	}
	return found.sort();
}

export function findProjects(workspaces: readonly Workspace[]): Project[] {
	const projects: Project[] = [];
	const seen = new Set<string>();
	for (const workspace of workspaces) {
		for (const root of workspace.roots) {
			for (const dir of expandRoot(root)) {
				if (seen.has(dir)) continue;
				seen.add(dir);
				projects.push({ workspace: workspace.name, name: basename(dir), path: `${basename(dirname(dir))}/${basename(dir)}`, dir });
			}
		}
	}
	return projects;
}

/** The project `query` names: its name, parent/name, or its directory. Throws, saying why, when none or several match. */
export function findProject(projects: readonly Project[], query: string): Project {
	const dir = resolve(expandHome(query));
	const byDir = projects.find((p) => p.dir === dir);
	if (byDir !== undefined) return byDir;
	const matches = projects.filter((p) => p.name === query || p.path === query);
	if (matches.length === 1) return matches[0]!;
	if (matches.length > 1) throw new Error(`${query} could be ${matches.map((p) => p.path).join(" or ")}; name one of those`);
	throw new Error(`no project ${query}; aludra projects lists them`);
}
