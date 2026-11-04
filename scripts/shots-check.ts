// Step 5's live check (screenshots), run by hand against a sandbox host: a real model (the settings' default, so Claude
// through the user's Claude Code) in a sandbox session of a scratch clone of PROJECT_DIR, a web project with Playwright
// among its dependencies. The clone gets an .agents/setup that installs it and Chromium, and an .agents/project.json
// declaring its dev server (DEV_COMMAND on PORT) and the page "/". One turn makes a visible change; the check prints the
// result's shots, saves the PNGs it gets back through task.shot's path to OUT_DIR, and checks the agent's files and
// files are as they were. The sandbox is deleted at the end.
//
//   node --no-warnings scripts/shots-check.ts SANDBOX_HOST_JSON PROJECT_DIR DEV_COMMAND PORT OUT_DIR
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { configFor } from "../src/config.ts";
import { context, openHost } from "../src/host.ts";

const [hostFile, source, devCommand, port, out] = process.argv.slice(2);
if (hostFile === undefined || source === undefined || devCommand === undefined || port === undefined || out === undefined) throw new Error("usage: shots-check.ts SANDBOX_HOST_JSON PROJECT_DIR DEV_COMMAND PORT OUT_DIR");
const root = mkdtempSync(join(tmpdir(), "aludra-shots-"));
const name = `${basename(source)}-shots`;
const dir = join(root, "Projects", "Software", name);
mkdirSync(join(root, "Projects", "Software"), { recursive: true });
execFileSync("git", ["clone", "-q", source, dir]);
mkdirSync(join(dir, ".agents"), { recursive: true });
writeFileSync(join(dir, ".agents", "setup"), "#!/usr/bin/env bash\nset -euo pipefail\npnpm install --frozen-lockfile\npnpm exec playwright install --with-deps chromium\n");
chmodSync(join(dir, ".agents", "setup"), 0o755);
writeFileSync(join(dir, ".agents", "project.json"), JSON.stringify({ checks: [{ name: "types", command: "pnpm exec tsc --noEmit" }], devServer: { command: devCommand, port: Number(port) }, pages: [{ path: "/", label: "Home" }] }, null, "\t"));
execFileSync("git", ["-C", dir, "add", ".agents"]);
execFileSync("git", ["-C", dir, "-c", "user.name=check", "-c", "user.email=check@example.com", "commit", "-q", "-m", "Declare setup, checks and screenshots"]);

const config = configFor(JSON.stringify({ dataDir: join(root, "data"), workspaces: [{ name: "x", roots: [join(root, "Projects", "*", "*")] }], model: { thinking: "low" }, sandboxes: JSON.parse(readFileSync(hostFile, "utf8")) }), {}).config;
const host = await openHost({ config });
host.resume();
const seconds = (since: number) => `${Math.round((Date.now() - since) / 1000)}s`;
let sandbox: number | undefined;
try {
	const started = Date.now();
	const project = host.projects().find((p) => p.dir === dir)!;
	const record = await host.sessions.createSandbox(project, "shots check", {});
	sandbox = record.sandbox;
	console.log(`sandbox ${sandbox} ready in ${seconds(started)}`);
	const task = "On the home page, add a visible line of text near the top that says 'Screenshot check'. Keep it small and commit it. Don't start a dev server.";
	const settled = await (await host.submit(record.id, task)).wait(context);
	console.log(`turn ${settled.status} in ${seconds(started)}`);
	const before = await host.sandboxes.sync(record.id);
	const shotsStarted = Date.now();
	await host.results.afterRun(record.id);
	console.log(`checks and shots in ${seconds(shotsStarted)}`);
	const after = await host.sandboxes.sync(record.id);
	console.log(`sandbox untouched: head ${before.head === after.head}, uncommitted ${before.uncommitted} then ${after.uncommitted}`);
	const result = await host.results.result(record.id);
	if (result === undefined || !("shots" in result)) throw new Error(`no result: ${JSON.stringify(result)}`);
	console.log("checks:", JSON.stringify(result.checks.map((c) => ({ ...c, detail: c.detail?.slice(-200) }))));
	console.log("shots:", JSON.stringify(result.shots));
	mkdirSync(out, { recursive: true });
	for (const shot of result.shots) {
		const png = await host.results.shot(record.id, shot.id);
		if (png === undefined) throw new Error(`shot ${shot.id} isn't served`);
		writeFileSync(join(out, `${shot.side}-${shot.id}.png`), png);
		console.log(`${shot.side} ${shot.label}: ${png.length} bytes, PNG ${png.subarray(1, 4).toString() === "PNG"}`);
	}
	console.log("line:", await host.results.line(record.id, false));
	console.log(`done in ${seconds(started)}; data in ${root}`);
} finally {
	if (sandbox !== undefined) await host.sandboxes.remove(sandbox).catch((error) => console.error(`couldn't delete sandbox ${sandbox}: ${error}`));
	await host.close();
}
