import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { isListening } from "../src/server.ts";
import { makeProject, tempDir } from "./helpers.ts";

const main = join(import.meta.dirname, "..", "src", "main.ts");

test("a run killed with kill -9 during a tool call carries on after a restart, and ask reattaches by request id", async (t) => {
	const dir = tempDir(t);
	const project = makeProject(dir, "one");
	const config = join(dir, "aludra.json");
	writeFileSync(config, JSON.stringify({ workspaces: [{ name: "test", roots: [join(dir, "Projects/*/*")] }] }));
	const env = { ...process.env, ALUDRA_CONFIG: config, ALUDRA_DATA_DIR: join(dir, "data"), ALUDRA_MODEL: "faux" };
	const socket = join(dir, "data", "aludra.sock");
	const servers: ChildProcess[] = [];
	t.after(() => servers.forEach((s) => s.kill("SIGKILL")));
	const serve = async () => {
		const server = spawn(process.execPath, ["--no-warnings", main, "serve"], { env, stdio: "ignore" });
		servers.push(server);
		while (!(await isListening(socket))) await new Promise((resolve) => setTimeout(resolve, 50));
		return server;
	};
	const cli = (...args: string[]) => spawnSync(process.execPath, ["--no-warnings", main, ...args], { env, encoding: "utf8", timeout: 30_000 });

	const first = await serve();
	// The faux model calls bash with `sleep 4 && pwd`; the client gives up and the server is killed during the sleep.
	const asking = spawn(process.execPath, ["--no-warnings", main, "ask", "--project", "one", "--id", "req-1", "where are you?"], { env });
	let output = "";
	asking.stdout.on("data", (chunk) => (output += chunk));
	while (!output.includes("· bash")) await new Promise((resolve) => setTimeout(resolve, 50));
	first.kill("SIGKILL");
	await new Promise((resolve) => asking.once("exit", resolve));
	const session = /session (\d+) in one/.exec(output)?.[1];
	assert.ok(session, output);

	await serve();
	const listed = cli("sessions");
	// Piped, so plain: the project and its path, then the session's mark, ID and title.
	assert.match(listed.stdout, new RegExp(`^one  \\S+/one\\n  [◐□·✓] ${session}  where are you\\?`));
	const again = cli("ask", "--session", session, "--id", "req-1", "where are you?");
	assert.equal(again.status, 0, again.stderr);
	// The bash call was cut off, so the model is told it may have partly run; the same request id found the same run.
	assert.match(again.stdout, /Tool came back: .*interrupted/);
	const after = cli("ask", "--session", session, "and now?");
	assert.match(after.stdout, new RegExp(`Tool came back: .*${project.dir}`));
});

test("the CLI says what's wrong with a bad command or a missing server", (t) => {
	const dir = tempDir(t);
	const env = { ...process.env, ALUDRA_DATA_DIR: dir, ALUDRA_MODEL: "faux" };
	const cli = (...args: string[]) => spawnSync(process.execPath, ["--no-warnings", main, ...args], { env, encoding: "utf8" });
	assert.match(cli("--help").stdout, /usage: aludra/);
	assert.match(cli("frobnicate").stderr, /unknown command frobnicate/);
	assert.match(cli("ask", "hello").stderr, /needs --project or --session/);
	assert.match(cli("sessions").stderr, /can't reach the aludra server/);
	assert.match(cli("stop").stderr, /needs --session ID/);
});
