import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { configFor, rootListsChildren } from "../src/config.ts";
import { checkName, createNewProjects, ghProblem, NewProjectRefused, readme } from "../src/new-projects.ts";
import { fakeGh, GIT_ENV, git, tempDir } from "./helpers.ts";

function setup(t: TestContext, options: Parameters<typeof fakeGh>[1] = {}) {
	const root = tempDir(t);
	const projects = join(root, "Projects", "Software");
	const fake = fakeGh(join(root, "github"), options);
	process.env.GIT_AUTHOR_NAME ??= GIT_ENV.GIT_AUTHOR_NAME;
	const made = createNewProjects({ root: projects, owner: "t", ...fake });
	return { root, projects, fake, made: { ...made, remote: (name: string) => fake.remoteUrl(`t/${name}`) } };
}

test("a project name is lowercase letters, digits and -", () => {
	assert.equal(checkName("waygate-2"), "waygate-2");
	for (const bad of ["Waygate", "-x", "x-", "a b", "a/b", "", ".x", "x".repeat(101), 3]) assert.throws(() => checkName(bad), NewProjectRefused, String(bad));
	assert.equal(readme("waygate", " A tool for gates. "), "# waygate\n\nA tool for gates.\n");
	assert.equal(readme("waygate"), "# waygate\n");
});

test("newProjects.root has to be one a workspace root lists the folders of", () => {
	const workspaces = [{ name: "w", roots: ["/home/b/westwood/Projects/*/*", "/home/b/westwood/Personal/*"] }];
	assert.equal(rootListsChildren(workspaces, "/home/b/westwood/Projects/Software"), true);
	assert.equal(rootListsChildren(workspaces, "/home/b/westwood/Personal"), true);
	assert.equal(rootListsChildren(workspaces, "/home/b/westwood/Projects"), false);
	assert.equal(rootListsChildren(workspaces, "/home/b/elsewhere"), false);
	const settings = (root: string) => JSON.stringify({ workspaces, newProjects: { root, owner: "brad-j" } });
	assert.deepEqual(configFor(settings("/home/b/westwood/Projects/Software"), {}).errors, []);
	assert.match(configFor(settings("/home/b/westwood/Projects"), {}).errors.join("\n"), /isn't under a workspace root/);
	assert.match(configFor(JSON.stringify({ workspaces, newProjects: { root: "/home/b/westwood/Personal", owner: "not an owner" } }), {}).errors.join("\n"), /isn't a GitHub account/);
});

test("gh that isn't signed in is a reason, said in words", async () => {
	assert.equal(await ghProblem(async () => ""), undefined);
	assert.match((await ghProblem(fakeGh("/tmp/unused-gh", { signedIn: false }).gh))!, /token for github.com is invalid/);
	assert.match((await ghProblem(async () => {
		throw new Error("gh auth status: You are not logged into any GitHub hosts.");
	}))!, /isn't signed in/);
});

test("a new project is a folder with a README, a first commit on main, and a private repository it's pushed to", async (t) => {
	const { projects, fake, made } = setup(t);
	const { dir, repository } = await made.create("waygate", "A tool for gates.");
	assert.equal(dir, join(projects, "waygate"));
	assert.equal(repository, "t/waygate");
	assert.equal(readFileSync(join(dir, "README.md"), "utf8"), "# waygate\n\nA tool for gates.\n");
	assert.equal(git(dir, "branch", "--show-current"), "main");
	assert.equal(git(dir, "log", "--format=%s"), "Start waygate: A tool for gates.");
	assert.equal(git(dir, "status", "--porcelain"), "");
	assert.equal(git(dir, "rev-parse", "--abbrev-ref", "main@{u}"), "origin/main");
	assert.equal(git(join(fake.remoteUrl("t/waygate")), "rev-parse", "main"), git(dir, "rev-parse", "HEAD"));
	assert.deepEqual(fake.calls.find((c) => c[1] === "create"), ["repo", "create", "t/waygate", "--private", "--description", "A tool for gates."]);
});

test("a name taken here or on GitHub is refused before anything is made", async (t) => {
	const { projects, made } = setup(t);
	await made.create("one");
	await assert.rejects(made.create("one"), (error: Error) => error instanceof NewProjectRefused && /already exists/.test(error.message));
	mkdirSync(join(projects, "two"));
	await assert.rejects(made.create("two"), (error: Error) => error instanceof NewProjectRefused && /two already exists/.test(error.message));
	// Only on GitHub: the folder isn't here, the repository is.
	execFileSync("git", ["init", "-q", "--bare", made.remote("three")]);
	await assert.rejects(made.create("three"), (error: Error) => error instanceof NewProjectRefused && /github.com\/t\/three already exists/.test(error.message));
	assert.equal(existsSync(join(projects, "three")), false);
	await assert.rejects(made.create("Bad Name"), NewProjectRefused);
});

test("a failure removes the folder it made, and says when the repository was made and left", async (t) => {
	const before = setup(t, { failCreate: true });
	await assert.rejects(before.made.create("four"), (error: Error) => !(error instanceof NewProjectRefused) && /couldn't make four: gh repo create: HTTP 403/.test(error.message));
	assert.equal(existsSync(join(before.projects, "four")), false);
	const after = setup(t, { failAfterCreate: true });
	await assert.rejects(after.made.create("five"), /github.com\/t\/five was created and is left there; delete it/);
	assert.equal(existsSync(join(after.projects, "five")), false);
});

test("a project can start from another repository's commits in place of a first commit", async (t) => {
	const { root, made } = setup(t);
	const work = join(root, "work");
	mkdirSync(work);
	git(work, "init", "-q", "-b", "main");
	git(work, "commit", "-q", "--allow-empty", "-m", "empty");
	git(work, "commit", "-q", "--allow-empty", "-m", "the work");
	const { dir } = await made.create("six", undefined, { source: work, ref: "main" });
	assert.deepEqual(git(dir, "log", "--format=%s").split("\n"), ["the work", "empty"]);
	assert.equal(existsSync(join(dir, "README.md")), false);
});
