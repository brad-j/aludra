// Live check of new projects, run by hand on a machine with gh signed in, a sandbox host and Claude Code: makes project
// NAME-a with projects.create (a private repository under OWNER on GitHub, pushed over SSH), then a scratch sandbox
// session whose agent commits a file, promoted to project NAME-b, and checks both repositories' main on GitHub. The
// host runs in a temp data directory with the projects in a temp root; the sandbox is deleted at the end. The two
// repositories are left on GitHub for the user to delete, since that needs gh's delete_repo scope:
//
//   node --no-warnings scripts/new-projects-check.ts SANDBOX_HOST_JSON OWNER NAME
//   gh repo delete OWNER/NAME-a --yes && gh repo delete OWNER/NAME-b --yes
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configFor } from "../src/config.ts";
import { context, openHost } from "../src/host.ts";
import { describeAnswer } from "../src/server.ts";
import { run } from "../src/sandboxes.ts";

const [hostFile, owner, name] = process.argv.slice(2);
if (hostFile === undefined || owner === undefined || name === undefined) throw new Error("usage: new-projects-check.ts SANDBOX_HOST_JSON OWNER NAME");
const root = mkdtempSync(join(tmpdir(), "aludra-new-"));
const projects = join(root, "Projects", "Software");
const config = configFor(JSON.stringify({ dataDir: join(root, "data"), workspaces: [{ name: "x", roots: [join(root, "Projects", "*", "*")] }], model: { thinking: "low" }, sandboxes: JSON.parse(readFileSync(hostFile, "utf8")), newProjects: { root: projects, owner } }), {}).config;
const host = await openHost({ config });
host.resume();
let sandbox: number | undefined;
let failed = false;
const onGitHub = async (repository: string) => (await run("gh", ["api", `repos/${repository}/commits/main`, "--jq", ".commit.message"])).trim();
try {
	const info = await host.newProjects.info();
	if ("reason" in info) throw new Error(`can't make projects: ${info.reason}`);
	const a = await host.newProjects.create(`${name}-a`, "aludra's live check of new projects; delete me");
	const aMessage = await onGitHub(`${owner}/${a.name}`);
	console.log(`created ${a.dir}, github.com/${owner}/${a.name} main: ${aMessage}`);
	const aPrivate = (await run("gh", ["repo", "view", `${owner}/${a.name}`, "--json", "visibility", "--jq", ".visibility"])).trim();
	console.log(`  visibility ${aPrivate}`);

	const scratch = await host.sessions.createSandbox(undefined, "new projects check");
	sandbox = scratch.sandbox;
	const settled = await (await host.submit(scratch.id, "Use bash. Write a file hello.txt containing the single line: made in a scratch sandbox. Commit it with the message 'Add hello.txt'. Reply with the commit's hash.")).wait(context);
	const entries = (await (await host.conversation(scratch.id)).context(context)).entries;
	console.log(`scratch turn ${settled.status}: ${describeAnswer(entries.at(-1))?.split("\n")[0] ?? "(none)"}`);
	const b = await host.newProjects.promote(scratch.id, `${name}-b`, "aludra's live check of promote; delete me");
	const bMessage = await onGitHub(`${owner}/${b.name}`);
	const hello = await run("git", ["-C", b.dir, "show", "main:hello.txt"]).catch(() => "");
	const record = await host.sessions.get(scratch.id);
	console.log(`promoted to ${b.dir}, github.com/${owner}/${b.name} main: ${bMessage}`);
	console.log(`  hello.txt: ${hello.trim()}; session now in ${record?.project}, scratch ${record?.scratch === true}`);
	failed = aPrivate !== "PRIVATE" || !/Start /.test(aMessage) || bMessage !== "Add hello.txt" || hello.trim() !== "made in a scratch sandbox" || record?.project !== b.name;
	console.log(failed ? "CHECK BY EYE" : "ok");
} finally {
	if (sandbox !== undefined) await host.sandboxes.remove(sandbox).catch((error: Error) => console.error(`removing sandbox ${sandbox}: ${error.message}`));
	await host.close();
	rmSync(root, { recursive: true, force: true });
	console.log(`left on GitHub: gh repo delete ${owner}/${name}-a --yes && gh repo delete ${owner}/${name}-b --yes`);
}
process.exitCode = failed ? 1 : 0;
