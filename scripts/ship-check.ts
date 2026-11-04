// Step 6's live check (groups, pushes and ships kept on the summary), run by hand against a sandbox host: a real model
// (the settings' default, so Claude through the user's Claude Code) in a sandbox session of a scratch clone of
// PROJECT_DIR whose origin is a local bare repository. One turn makes a small change, then a ship lands it on that
// origin's main. The check prints the turn's result, the ship turn's result block (to see whether it reads as the work
// or as the rebase), the summary's ship state, the line, and the Done and ship notifications' text. The sandbox is
// deleted at the end; nothing reaches the project's real remote.
//
//   node --no-warnings scripts/ship-check.ts SANDBOX_HOST_JSON PROJECT_DIR
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { configFor } from "../src/config.ts";
import { context, openHost, sandboxBranch } from "../src/host.ts";
import { shipOutcome, shipSentence } from "../src/ship.ts";
import { textOf } from "../src/transcript.ts";

const [hostFile, source] = process.argv.slice(2);
if (hostFile === undefined || source === undefined) throw new Error("usage: ship-check.ts SANDBOX_HOST_JSON PROJECT_DIR");
const root = mkdtempSync(join(tmpdir(), "aludra-ship-"));
const name = `${basename(source)}-ship`;
const dir = join(root, "Projects", "Software", name);
const origin = join(root, `${name}.git`);
mkdirSync(join(root, "Projects", "Software"), { recursive: true });
execFileSync("git", ["clone", "-q", "--bare", source, origin]);
execFileSync("git", ["clone", "-q", origin, dir]);

const config = configFor(JSON.stringify({ dataDir: join(root, "data"), workspaces: [{ name: "x", roots: [join(root, "Projects", "*", "*")] }], model: { thinking: "low" }, sandboxes: JSON.parse(readFileSync(hostFile, "utf8")) }), {}).config;
const host = await openHost({ config });
host.resume();
const seconds = (since: number) => `${Math.round((Date.now() - since) / 1000)}s`;
let sandbox: number | undefined;
try {
	const started = Date.now();
	const project = host.projects().find((p) => p.dir === dir)!;
	const record = await host.sessions.startSandbox(project, "ship check", {}, { group: "ship-check" });
	const task = "Add one sentence to the end of README.md saying the project can be worked on in a sandbox. Commit it.";
	await host.sandboxes.hold(record.id, task, "first", true);
	const ready = await host.sandboxes.prepared(record.id);
	sandbox = ready.sandbox;
	console.log(`sandbox ${sandbox} ready in ${seconds(started)}`);
	// The held message runs once the sandbox is ready; wait for its run to end.
	while ((await host.sessions.states()).get(record.id) !== "idle" || (await host.results.result(record.id)) === undefined) await new Promise((r) => setTimeout(r, 1000));
	console.log(`turn done in ${seconds(started)}`);
	await host.sandboxes.sync(record.id);
	const work = await host.results.result(record.id);
	console.log("result:", JSON.stringify(work, null, 2));
	console.log("line:", await host.results.line(record.id, false));
	const branch = sandboxBranch((await host.sessions.get(record.id))!);
	if (work !== undefined && "code" in work) console.log(`done push: ${work.question === undefined ? `${work.code.commits} commit${work.code.commits === 1 ? "" : "s"} on ${branch} · ${work.summary}` : `Asks: ${work.question.text}`}`);

	const shipStart = Date.now();
	const shipped = await (await host.ships.start(record.id, { mode: "main" })).done;
	console.log(`ship ${shipped.shipped ? "landed" : `stopped (${shipped.kind}): ${shipped.reason}`} in ${seconds(shipStart)}`);
	console.log("ship push:", shipSentence(shipOutcome(shipped, Date.now())));
	const after = await host.sessions.get(record.id);
	console.log("record:", JSON.stringify({ shipped: after?.shipped, shipStopped: after?.shipStopped, group: after?.group }));
	console.log("line after the ship:", await host.results.line(record.id, false));
	const conversation = await host.conversation(record.id);
	const newest = (await conversation.entries({}, 1, undefined, context)).items[0];
	const answer = newest?.model?.at(-1);
	console.log("ship answer:\n", answer?.role === "assistant" ? textOf(answer.content) : "(none)");
	console.log("ship result:", JSON.stringify(await host.results.result(record.id), null, 2));
	console.log("origin main:", execFileSync("git", ["-C", origin, "log", "-2", "--format=%h %s", "main"], { encoding: "utf8" }).trim());
	console.log(`done in ${seconds(started)}; data in ${root}`);
} finally {
	if (sandbox !== undefined) await host.sandboxes.remove(sandbox).catch((error) => console.error(`couldn't delete sandbox ${sandbox}: ${error}`));
	await host.close();
}
