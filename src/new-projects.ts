// New projects, made here so every task after the first commit can run in a sandbox (amyrlin's protocol section 10
// item 20): a folder in `newProjects.root`, `git init` on main, a README and a first commit with this machine's git
// identity, then a private GitHub repository under `newProjects.owner` through gh, pushed, so origin/main is the
// upstream a ship lands on. A scratch sandbox's work becomes a project the same way, its commits in place of the first.
//
// Nothing is left half made: a folder made here is removed when a later step fails. A repository gh created is left
// for the user to delete, since deleting one needs a scope aludra shouldn't ask for, and the message says so.
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { run } from "./sandboxes.ts";

/** Why a project can't be made from what was asked: the client's mistake, not the machine's. */
export class NewProjectRefused extends Error {}

/** A folder and repository name: lowercase letters, digits and `-`, starting with a letter or digit, at most 100. */
export function checkName(name: unknown): string {
	if (typeof name !== "string") throw new NewProjectRefused("name is required");
	if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(name)) throw new NewProjectRefused(`${JSON.stringify(name)} isn't a project name: use lowercase letters, digits and -, starting with a letter or digit`);
	if (name.endsWith("-")) throw new NewProjectRefused(`${name} can't end with -`);
	return name;
}

/** The README a new project starts with. */
export function readme(name: string, description?: string): string {
	const about = description?.trim();
	return `# ${name}\n${about === undefined || about === "" ? "" : `\n${about}\n`}`;
}

/** What making a project needs of this machine: git, and gh signed in. Tests replace `gh`. */
export type NewProjectsOptions = {
	root: string;
	owner: string;
	/** Runs gh with `args` in `cwd`; resolves with its output, rejects with its error. */
	gh?: (args: readonly string[], cwd?: string) => Promise<string>;
	/** The remote URL for `owner/name`; `git@github.com:owner/name.git` by default. Tests point it at a bare repository. */
	remoteUrl?: (repository: string) => string;
};

const realGh = (args: readonly string[], cwd?: string) => (cwd === undefined ? run("gh", args) : run("gh", ["-R", "", ...args].slice(2)).then(() => "")).catch((error) => {
	throw error;
}) as Promise<string>;

/** Runs gh in `cwd`. */
function ghIn(args: readonly string[], cwd?: string): Promise<string> {
	return new Promise((resolve, reject) => {
		void import("node:child_process").then(({ execFile }) => {
			execFile("gh", [...args], { cwd, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: "1" } }, (error, stdout, stderr) => {
				if (error) reject(new Error(`gh ${args.slice(0, 2).join(" ")}: ${stderr.trim() || error.message}`));
				else resolve(stdout);
			});
		});
	});
}
void realGh;

/** Whether gh can make repositories here: signed in, its token good. Undefined when it can, else why not. */
export async function ghProblem(gh: NewProjectsOptions["gh"] = ghIn): Promise<string | undefined> {
	try {
		await gh(["auth", "status", "--hostname", "github.com"]);
		return undefined;
	} catch (error) {
		const text = error instanceof Error ? error.message : String(error);
		if (/ENOENT|not found/i.test(text) && !/token/i.test(text)) return "gh isn't installed";
		if (/invalid/i.test(text)) return "gh's token for github.com is invalid; run gh auth login with the repo scope";
		return "gh isn't signed in to github.com; run gh auth login with the repo scope";
	}
}

/**
 * Makes new projects. `create` checks the name, makes `<root>/<name>` with its first commit (or `from`'s commits),
 * creates `<owner>/<name>` private on GitHub and pushes main to it. Returns the project's directory.
 */
export function createNewProjects(options: NewProjectsOptions) {
	const gh = options.gh ?? ghIn;

	/** Throws NewProjectRefused when `name` is taken, here or on GitHub. */
	async function checkFree(name: string): Promise<string> {
		const dir = join(options.root, name);
		if (existsSync(dir)) throw new NewProjectRefused(`${dir} already exists`);
		const exists = await gh(["repo", "view", `${options.owner}/${name}`, "--json", "name"]).then(() => true, (error: Error) => {
			if (/could not resolve|not found|404/i.test(error.message)) return false;
			throw error;
		});
		if (exists) throw new NewProjectRefused(`github.com/${options.owner}/${name} already exists`);
		return dir;
	}

	/**
	 * Makes project `name`. `from` puts commits in place of the first: a git bundle, or a repository, whose `ref` becomes
	 * main. Throws NewProjectRefused for the caller's mistakes and Error for git or gh failing.
	 */
	async function create(name: unknown, description?: string, from?: { source: string; ref: string }): Promise<{ dir: string; repository: string }> {
		const checked = checkName(name);
		if (description !== undefined && typeof description !== "string") throw new NewProjectRefused("description should be text");
		const dir = await checkFree(checked);
		const repository = `${options.owner}/${checked}`;
		const git = (...args: string[]) => run("git", ["-C", dir, ...args]);
		let created = false;
		try {
			await mkdir(options.root, { recursive: true });
			await mkdir(dir);
			await git("init", "-q", "-b", "main");
			if (from === undefined) {
				await writeFile(join(dir, "README.md"), readme(checked, description));
				await git("add", "README.md");
				await git("commit", "-q", "-m", `Start ${checked}${description?.trim() ? `: ${description.trim()}` : "."}`);
			} else {
				// main is born checked out and empty, so the commits come in under another name, and main is set to them.
				await git("fetch", "-q", from.source, `${from.ref}:refs/aludra/start`);
				await git("reset", "-q", "--hard", "refs/aludra/start");
				await git("update-ref", "-d", "refs/aludra/start");
			}
			await gh(["repo", "create", repository, "--private", ...(description?.trim() ? ["--description", description.trim()] : [])], dir);
			created = true;
			// Over SSH, as this machine's other projects are, so pushes and ships don't need gh.
			await git("remote", "add", "origin", options.remoteUrl?.(repository) ?? `git@github.com:${repository}.git`);
			await git("push", "-q", "-u", "origin", "main");
			return { dir, repository };
		} catch (error) {
			await rm(dir, { recursive: true, force: true });
			const why = error instanceof Error ? error.message : String(error);
			throw new Error(created ? `couldn't finish ${checked}: ${why}. github.com/${repository} was created and is left there; delete it before trying the name again` : `couldn't make ${checked}: ${why}`);
		}
	}

	return { create, checkFree };
}

export type NewProjects = ReturnType<typeof createNewProjects>;
