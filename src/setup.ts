// `aludra init`: writes the settings file from a few questions, each with a guess as its default. The workspace roots
// are guessed from where git repositories are under the home directory; the login from Tailscale.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { type Config, defaultConfigFile } from "./config.ts";
import { expandRoot } from "./projects.ts";
import { type TailnetSelf, tailnetSelf, tailscaleFor } from "./tailscale.ts";

/** Folders of the home directory not worth looking through for projects. */
const SKIP = new Set(["Library", "Applications", "Movies", "Music", "Pictures", "Public", "node_modules", "snap", "go", "venv"]);

/** Git repositories under `home`, at most `depth` levels down, not looking inside one. */
export function findRepositories(home: string, depth = 4, limit = 5000): string[] {
	const found: string[] = [];
	let seen = 0;
	const walk = (dir: string, level: number) => {
		if (level > depth || seen > limit) return;
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		seen += 1;
		if (level > 0 && entries.some((e) => e.name === ".git")) {
			found.push(dir);
			return;
		}
		for (const entry of entries) {
			if (entry.isDirectory() && !entry.name.startsWith(".") && !SKIP.has(entry.name)) walk(join(dir, entry.name), level + 1);
		}
	};
	walk(home, 0);
	return found.sort();
}

/** Root patterns that cover `repositories`, the most covered first: each repository's parent with `/*`, and sibling
 * parents folded into one root with a `*` for the middle folder (~/Projects/Software and ~/Projects/Tools become
 * ~/Projects/ then `*` twice). */
export function suggestRoots(home: string, repositories: readonly string[]): string[] {
	const parents = new Map<string, number>();
	for (const repo of repositories) {
		const parent = dirname(repo);
		if (parent === home) continue;
		parents.set(parent, (parents.get(parent) ?? 0) + 1);
	}
	const roots = new Map<string, number>();
	const byGrandparent = Map.groupBy([...parents.keys()], (parent) => dirname(parent));
	for (const [grandparent, siblings] of byGrandparent) {
		const count = siblings.reduce((sum, parent) => sum + parents.get(parent)!, 0);
		if (siblings.length > 1 && grandparent !== home) roots.set(`${grandparent}${sep}*${sep}*`, count);
		else for (const parent of siblings) roots.set(`${parent}${sep}*`, parents.get(parent)!);
	}
	// A root whose folders are mostly not repositories, or that takes in a folder holding them, is a folder of folders.
	const isRepo = new Set(repositories);
	const fits = (root: string) => {
		const matches = expandRoot(root);
		const holdsRepos = matches.some((dir) => repositories.some((repo) => repo.startsWith(`${dir}${sep}`)));
		return !holdsRepos && matches.filter((dir) => isRepo.has(dir)).length * 2 >= matches.length;
	};
	return [...roots.entries()]
		.filter(([root, count]) => count >= 2 && fits(root))
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([root]) => `~/${relative(home, root)}`);
}

export type InitAnswers = { name: string; roots: string[]; users: string[]; port?: number };

/** The settings file's text for `answers`. */
export function settingsText(answers: InitAnswers): string {
	const settings = {
		workspaces: [{ name: answers.name, roots: answers.roots }],
		api: { ...(answers.port === undefined ? {} : { port: answers.port }), users: answers.users },
	};
	return `${JSON.stringify(settings, null, "\t")}\n`;
}

export type InitOptions = {
	/** The file to write; default the settings file aludra reads without --config. */
	file?: string;
	roots?: string[];
	users?: string[];
	name?: string;
	yes?: boolean;
	force?: boolean;
};

/** Asks, writes the file, and returns what to do next, a line each. */
export async function init(config: Config, options: InitOptions): Promise<string[]> {
	const file = options.file ?? defaultConfigFile();
	if (existsSync(file) && options.force !== true) throw new Error(`${file} exists; edit it, or pass --force to write a new one`);
	const tailscale = tailscaleFor(config);
	const self: TailnetSelf | undefined = tailnetSelf(tailscale);
	const guess = {
		name: options.name ?? hostname().split(".")[0]!.toLowerCase(),
		roots: options.roots ?? suggestRoots(homedir(), findRepositories(homedir())),
		users: options.users ?? (self?.login === undefined ? [] : [self.login]),
	};
	const interactive = process.stdin.isTTY && options.yes !== true;
	if (!interactive && options.yes !== true) throw new Error("not a terminal, so nothing can be asked; pass --yes to take the guesses, with --root, --user and --name to change them");

	let answers: InitAnswers = guess;
	if (interactive) {
		const prompt = createInterface({ input: process.stdin, output: process.stdout });
		try {
			const ask = async (question: string, fallback: string) => (await prompt.question(`${question}${fallback ? ` [${fallback}]` : ""}: `)).trim() || fallback;
			const list = (text: string) => text.split(",").map((s) => s.trim()).filter(Boolean);
			console.log("Folders that hold your projects, as patterns: ~/code/* makes each folder in ~/code a project.");
			for (const root of guess.roots) console.log(`  ${root}  (${expandRoot(root).length} folders)`);
			const roots = list(await ask("Project folders, comma-separated", guess.roots.join(", ")));
			const users = list(await ask("Tailscale logins allowed in, comma-separated", guess.users.join(", ")));
			const name = await ask("This machine's name in amyrlin", guess.name);
			answers = { name, roots, users };
		} finally {
			prompt.close();
		}
	}
	if (answers.roots.length === 0) throw new Error("no project folders; name at least one, such as ~/code/*");
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, settingsText(answers), { mode: 0o600 });

	const projects = answers.roots.reduce((sum, root) => sum + expandRoot(root).length, 0);
	const lines = [`wrote ${file}: ${projects} project${projects === 1 ? "" : "s"}`];
	if (answers.users.length === 0) lines.push("no Tailscale login allowed in, so amyrlin and the API can't connect; add yours to api.users");
	lines.push("", "next:", "  aludra doctor", "  aludra service install", `  ${tailscale.command("serve", "--bg", String(config.api.port))}`);
	if (self !== undefined) lines.push("", `then add this machine in the Mac app: wss://${self.dnsName}/amyrlin`, `the API is at https://${self.dnsName}/api`);
	return lines;
}
