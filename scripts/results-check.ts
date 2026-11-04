// Step 4's live check (results), run by hand against a sandbox host: a real model (the settings' default, so Claude
// through the user's Claude Code) in a sandbox session of a scratch clone of PROJECT_DIR, which declares two checks in
// .agents/project.json. One turn makes a small change; the check prints the result block it gave, the plan, the
// declared checks run in the sandbox, the code counts and the line. The sandbox is deleted at the end.
//
//   node --no-warnings scripts/results-check.ts SANDBOX_HOST_JSON PROJECT_DIR
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { configFor } from "../src/config.ts";
import { context, openHost } from "../src/host.ts";

const [hostFile, source] = process.argv.slice(2);
if (hostFile === undefined || source === undefined) throw new Error("usage: results-check.ts SANDBOX_HOST_JSON PROJECT_DIR");
const root = mkdtempSync(join(tmpdir(), "aludra-results-"));
const name = `${basename(source)}-results`;
const dir = join(root, "Projects", "Software", name);
mkdirSync(join(root, "Projects", "Software"), { recursive: true });
execFileSync("git", ["clone", "-q", source, dir]);
mkdirSync(join(dir, ".agents"), { recursive: true });
writeFileSync(join(dir, ".agents", "project.json"), JSON.stringify({ checks: [{ name: "tests", command: "pnpm test" }, { name: "always fails", command: "echo 'this check fails on purpose'; exit 1" }] }, null, "\t"));
execFileSync("git", ["-C", dir, "add", ".agents/project.json"]);
execFileSync("git", ["-C", dir, "-c", "user.name=check", "-c", "user.email=check@example.com", "commit", "-q", "-m", "Declare checks"]);

const config = configFor(JSON.stringify({ dataDir: join(root, "data"), workspaces: [{ name: "x", roots: [join(root, "Projects", "*", "*")] }], model: { thinking: "low" }, sandboxes: JSON.parse(readFileSync(hostFile, "utf8")) }), {}).config;
const host = await openHost({ config });
host.resume();
const seconds = (since: number) => `${Math.round((Date.now() - since) / 1000)}s`;
let sandbox: number | undefined;
try {
	const started = Date.now();
	const project = host.projects().find((p) => p.dir === dir)!;
	const record = await host.sessions.createSandbox(project, "results check", {});
	sandbox = record.sandbox;
	console.log(`sandbox ${sandbox} ready in ${seconds(started)}`);
	const task = "Add a short 'Checks' section to the end of README.md saying the project's checks are declared in .agents/project.json. Commit it. Keep it to two sentences.";
	const settled = await (await host.submit(record.id, task)).wait(context);
	console.log(`turn ${settled.status} in ${seconds(started)}`);
	await host.sandboxes.sync(record.id);
	const before = await host.results.result(record.id);
	console.log("before checks:", JSON.stringify(before, null, 2));
	await host.results.afterRun(record.id);
	const after = await host.results.result(record.id);
	console.log("checks:", JSON.stringify(after !== undefined && "checks" in after ? after.checks.map((c) => ({ ...c, detail: c.detail?.slice(-200) })) : after, null, 2));
	console.log("line:", await host.results.line(record.id, false));
	console.log(`done in ${seconds(started)}; data in ${root}`);
} finally {
	if (sandbox !== undefined) await host.sandboxes.remove(sandbox).catch((error) => console.error(`couldn't delete sandbox ${sandbox}: ${error}`));
	await host.close();
}
