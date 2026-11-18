// Live check of worktree ships (plan: worktree-ship-live-check), run by hand on the machine that ships worktree
// sessions, with Claude Code signed in and a git login that can push to UPSTREAM, a scratch repository made for it
// (`gh repo create OWNER/NAME --private --add-readme`, say). Nothing else of the owner's is touched: the host runs in a
// temp data directory with the project cloned into a temp root, and only UPSTREAM's main gets pushes.
//
//   node --no-warnings scripts/worktree-ship-check.ts UPSTREAM [--xcode] [--faux]
//
// --faux swaps Claude for a scripted model that commits and rebases, to try the script itself anywhere (against a
// local bare repository as UPSTREAM, say) without spending the subscription; it proves nothing about Claude.
//
// 1. Seeds UPSTREAM's main as the owner: `.agents/project.json` declaring a check that writes where it ran, the HEAD it
//    ran at and whether a push from its shell got through, to a marker file outside the project; with --xcode, also an
//    iOS Swift file and a check that type-checks it against the iOS Simulator SDK, which only a full Xcode has.
// 2. Serves the MCP endpoint on 127.0.0.1 with mcp.write, mcp.worktreeOnly and mcp.shipWorktrees on, and calls it as
//    Verin does: start_session gives a worktree session a small change to commit (with --xcode, one to the Swift file).
// 3. Moves UPSTREAM's main from a second clone, so the ship has to rebase.
// 4. ship_session, then check_sessions until it reports the ship.
// 5. Checks: UPSTREAM's main is the session's rebased worktree/N and holds the other clone's commit; the declared checks
//    ran in the worktree at that HEAD with their pushes refused; the base ref stayed out of the checkout; the checkout's
//    main was fast-forwarded; check_sessions reported "Shipped to main". When UPSTREAM is on GitHub and gh is signed in,
//    the repository's activity names who pushed the ship's head, which should be the owner's login.
//
// It spends a little of the subscription. UPSTREAM is left with the commits for the owner to delete or keep.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApi } from "../src/api.ts";
import { configFor } from "../src/config.ts";
import { openHost } from "../src/host.ts";
import { createModels } from "@earendil-works/pi-ai/models";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

const args = process.argv.slice(2);
const xcode = args.includes("--xcode");
const faux = args.includes("--faux");
const upstream = args.find((a) => !a.startsWith("--"));
if (upstream === undefined) throw new Error("usage: worktree-ship-check.ts UPSTREAM [--xcode]");

const git = (dir: string, ...rest: string[]) => execFileSync("git", ["-C", dir, ...rest], { encoding: "utf8" }).trim();
const results: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, detail: string) => {
	results.push([name, ok, detail]);
	console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${detail}`);
};
const seconds = (since: number) => `${Math.round((Date.now() - since) / 1000)}s`;
async function until<T>(what: string, minutes: number, get: () => Promise<T | undefined>): Promise<T> {
	const end = Date.now() + minutes * 60_000;
	for (;;) {
		const got = await get();
		if (got !== undefined) return got;
		if (Date.now() > end) throw new Error(`timed out after ${minutes} min waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 2000));
	}
}

if (xcode) {
	try {
		execFileSync("xcrun", ["--sdk", "iphonesimulator", "--show-sdk-path"], { stdio: "pipe" });
	} catch {
		throw new Error("--xcode needs a full Xcode selected (xcode-select -s /Applications/Xcode.app): xcrun can't find the iOS Simulator SDK");
	}
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "aludra-wtship-")));
const name = "worktree-ship-check";
const dir = join(root, "Projects", "Software", name);
const marker = join(root, "checks.log");
mkdirSync(join(root, "Projects", "Software"), { recursive: true });
execFileSync("git", ["clone", "-q", upstream, dir]);
const branch = git(dir, "symbolic-ref", "--short", "HEAD");
if (git(dir, "rev-parse", "--verify", "-q", "HEAD") === "") throw new Error(`${upstream} has no commits; make it with a README first`);

// 1. The seed, pushed as the owner. The marker's path is absolute, so a check run anywhere writes to the same file.
const where = `printf '%s %s %s\\n' "$(pwd -P)" "$(git rev-parse HEAD)" "$(git push --dry-run -q origin HEAD:refs/heads/aludra-probe >/dev/null 2>&1 && echo pushed || echo refused)" >> '${marker}'`;
const checks: { name: string; command: string }[] = [{ name: "where", command: where }];
mkdirSync(join(dir, ".agents"), { recursive: true });
if (xcode) {
	mkdirSync(join(dir, "Sources"), { recursive: true });
	writeFileSync(join(dir, "Sources", "Probe.swift"), "import UIKit\n\npublic func probeColor() -> UIColor { .systemBlue }\n");
	checks.push({ name: "ios typecheck", command: "xcrun --sdk iphonesimulator swiftc -target arm64-apple-ios17.0-simulator -typecheck Sources/*.swift" });
}
writeFileSync(join(dir, ".agents", "project.json"), `${JSON.stringify({ checks }, null, "\t")}\n`);
git(dir, "add", "-A");
git(dir, "commit", "-q", "-m", "Seed aludra's worktree ship check");
git(dir, "push", "-q", "origin", `HEAD:refs/heads/${branch}`);
console.log(`seeded ${upstream} ${branch} at ${git(dir, "rev-parse", "--short", "HEAD")}; data in ${root}`);

// 2. The host and its MCP endpoint, with the file-only settings a worktree ship needs.
const config = configFor(JSON.stringify({
	dataDir: join(root, "data"),
	workspaces: [{ name: "check", roots: [join(root, "Projects", "*", "*")] }],
	model: { thinking: "low" },
	mcp: { write: true, worktreeOnly: true, shipWorktrees: true },
}), {}).config;
const host = await openHost({ config, ...(faux ? fauxModel() : {}) });
host.resume();
const server = createApi(host, { users: [], name: "check" });
await new Promise<void>((resolve) => server.listen(0, resolve));
const url = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}/mcp`;
const writer = host.tokens.create("worktree-ship-check", "write");
const client = new Client({ name: "worktree-ship-check", version: "1" });
await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${writer.secret}` } } }));
const call = async (tool: string, args: Record<string, unknown>) => {
	const result = await client.callTool({ name: tool, arguments: args });
	const text = (result as { content: { text: string }[] }).content[0]!.text;
	if (result.isError === true) throw new Error(`${tool}: ${text}`);
	return JSON.parse(text);
};

let failed = false;
try {
	const started = Date.now();
	const tools = (await client.listTools()).tools.map((t) => t.name);
	check("ship_session offered", tools.includes("ship_session"), tools.join(", "));
	const task = xcode
		? "Add a public function `probeLabel() -> UILabel` to Sources/Probe.swift that returns a UILabel whose text is \"shipped from a worktree\", and add one sentence to the end of README.md saying so. Commit both with a clear message. Don't run any checks."
		: "Add one sentence to the end of README.md saying this repository is aludra's worktree ship check. Commit it with a clear message. Don't run any checks.";
	const session = await call("start_session", { project: name, task });
	console.log(`session ${session.id} on ${session.branch} in ${session.dir}`);
	const id = session.id as number;
	const seed = git(dir, "rev-parse", "HEAD");
	await until("the session's commit", 10, async () => ((await host.sessions.states()).get(id) === "idle" && git(dir, "rev-list", "--count", `${seed}..${session.branch}`) !== "0" ? true : undefined));
	console.log(`work committed in ${seconds(started)}: ${git(dir, "log", "-1", "--format=%h %s", session.branch)}`);

	// 3. Someone else's commit on the upstream.
	const other = join(root, "other");
	execFileSync("git", ["clone", "-q", upstream, other]);
	writeFileSync(join(other, "OTHER.md"), "Pushed from another clone while the session worked.\n");
	git(other, "add", "OTHER.md");
	git(other, "commit", "-q", "-m", "Someone else's change");
	git(other, "push", "-q", "origin", `HEAD:refs/heads/${branch}`);
	const moved = git(other, "rev-parse", "HEAD");

	// Handled up to now, so check_sessions' next entry for the session is the ship's.
	const before = await call("check_sessions", {});
	if (before.through !== undefined) await call("mark_sessions_handled", { through: before.through });

	// 4. The ship, as Verin calls it once the owner says yes.
	const shipStart = Date.now();
	const answer = await call("ship_session", { id });
	check("ship_session started", answer.started === true && answer.to === "main", JSON.stringify(answer));
	const reported = await until("check_sessions to report the ship", 20, async () => {
		const checked = await call("check_sessions", {});
		if (!checked.wake) return undefined;
		const entry = (JSON.parse(checked.data) as { id: number; ship?: { shipped?: boolean; shipping?: boolean; line?: string } }[]).find((e) => e.id === id);
		return entry?.ship !== undefined && entry.ship.shipping !== true ? entry.ship : undefined;
	});
	console.log(`ship ended in ${seconds(shipStart)}: ${JSON.stringify(reported)}`);
	check("check_sessions reported the ship", reported.shipped === true && (reported.line ?? "").startsWith("Shipped to main"), reported.line ?? "(no line)");

	// 5. What landed, and where the checks ran.
	const record = await host.sessions.get(id);
	const head = git(dir, "rev-parse", session.branch);
	execFileSync("git", ["-C", other, "fetch", "-q", "origin", branch]);
	const remoteMain = git(other, "rev-parse", "FETCH_HEAD");
	check("upstream main is the rebased worktree branch", remoteMain === head && record?.shipped?.head === head, `${upstream} ${branch} ${remoteMain.slice(0, 12)}, ${session.branch} ${head.slice(0, 12)}`);
	check("the rebase kept the other clone's commit", git(other, "merge-base", "--is-ancestor", moved, "FETCH_HEAD") === "", `${moved.slice(0, 12)} is in ${branch}`);
	const worktreeDir = realpathSync(git(record!.dir, "rev-parse", "--show-toplevel"));
	const lines = existsSync(marker) ? readFileSync(marker, "utf8").trim().split("\n") : [];
	const atHead = lines.filter((l) => l.split(" ")[1] === head);
	check("the declared checks ran in the worktree at the shipped HEAD", atHead.some((l) => l.split(" ")[0] === worktreeDir), atHead.join(" | ") || `no run at ${head.slice(0, 12)} in ${lines.length} line(s)`);
	check("a push from a check's shell was refused", atHead.length > 0 && atHead.every((l) => l.endsWith(" refused")), atHead.map((l) => l.split(" ")[2]).join(", "));
	check("no check ran in the checkout", !lines.some((l) => l.split(" ")[0] === realpathSync(dir)), `${lines.length} run(s) logged`);
	if (xcode) check("ios typecheck passed (no base failure)", record?.shipped?.baseFailures === undefined, JSON.stringify(record?.shipped?.baseFailures ?? []));
	let baseRefHidden = true;
	try {
		git(dir, "rev-parse", "--verify", "-q", "refs/worktree/aludra/base");
		baseRefHidden = false;
	} catch {}
	check("the base ref stayed out of the checkout", baseRefHidden, "refs/worktree/aludra/base is per worktree");
	check("the checkout's main fast-forwarded", git(dir, "rev-parse", branch) === head, git(dir, "log", "-1", "--format=%h %s", branch));
	check("no base worktree left behind", !git(dir, "worktree", "list").includes(".aludra-ship-"), git(dir, "worktree", "list").split("\n").length + " worktree(s)");

	// Who pushed, when GitHub can say.
	const repo = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(upstream)?.[1];
	if (repo !== undefined) {
		try {
			const me = execFileSync("gh", ["api", "user", "--jq", ".login"], { encoding: "utf8" }).trim();
			const pushes = execFileSync("gh", ["api", `repos/${repo}/activity?ref=refs/heads/${branch}&activity_type=push&per_page=10`, "--jq", ".[] | \"\\(.after) \\(.actor.login)\""], { encoding: "utf8" }).trim().split("\n");
			const ship = pushes.find((l) => l.startsWith(head));
			check("GitHub says the owner's login pushed the ship", ship !== undefined && ship.endsWith(` ${me}`), ship ?? `no push of ${head.slice(0, 12)} in the last ${pushes.length}`);
		} catch (error) {
			console.log(`(couldn't ask GitHub who pushed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}; check the repository's Activity page)`);
		}
	} else console.log("(not a GitHub upstream: check by eye that the push used this machine's git login)");
	console.log(`done in ${seconds(started)}; data in ${root}`);
} catch (error) {
	failed = true;
	console.error(error instanceof Error ? error.message : String(error));
} finally {
	await client.close().catch(() => {});
	await server.close();
	await host.close();
}
failed ||= results.some(([, ok]) => !ok);
console.log(failed ? "FAILED" : "all ok");
process.exitCode = failed ? 1 : 0;

/** For --faux: commits a line on README.md for the task, and rebases onto the base for the ship. */
function fauxModel() {
	const provider = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	provider.setResponses(Array.from({ length: 40 }, () => (ctx: TranscriptContext) => {
		const last = ctx.messages.at(-1);
		const user = JSON.stringify(ctx.messages.findLast((m) => m.role === "user")?.content ?? "");
		if (last?.role === "toolResult") return fauxAssistantMessage(fauxText(/SHIP-READY/.test(user) ? "Rebased.\nSHIP-READY" : "Committed."));
		if (/SHIP-READY/.test(user)) return fauxAssistantMessage(fauxToolCall("bash", { command: "git rebase -q refs/worktree/aludra/base 2>&1" }), { stopReason: "toolUse" });
		return fauxAssistantMessage(fauxToolCall("bash", { command: "echo 'Worktree ship check.' >> README.md && git add README.md && git -c user.name=faux -c user.email=faux@example.com commit -q -m 'Say what this repository is for'" }), { stopReason: "toolUse" });
	}));
	const models = createModels();
	models.setProvider(provider.provider);
	return { models, model: { provider: "faux", modelId: "faux-1" } };
}
