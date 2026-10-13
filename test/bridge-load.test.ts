// The real pi-claude-bridge, loaded the way the host loads it. Loading starts no Claude Code query.
import assert from "node:assert/strict";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { claudeExecutable, findExecutable, loadBridge } from "../src/bridge.ts";
import { tempDir } from "./helpers.ts";

function fakeClaude(dir: string): string {
	const file = join(dir, "claude");
	writeFileSync(file, "#!/bin/sh\nexit 0\n");
	chmodSync(file, 0o755);
	return file;
}

test("Claude Code is found as named or on PATH, and a missing one says how to fix it", (t) => {
	const dir = tempDir(t);
	const claude = fakeClaude(dir);
	assert.equal(findExecutable("claude", { PATH: `/nonexistent:${dir}` }), claude);
	assert.equal(findExecutable(claude, { PATH: "" }), claude);
	assert.equal(findExecutable("claude", { PATH: "/nonexistent" }), undefined);
	writeFileSync(join(dir, "plain"), "");
	assert.equal(findExecutable(join(dir, "plain")), undefined, "a file that can't run isn't one");
	assert.throws(() => claudeExecutable(join(dir, "missing")), /no Claude Code at .*claude.path/);
});

test("the bridge runs the configured Claude Code, with its settings and logs in its own directory", async (t) => {
	const dir = tempDir(t);
	const claude = fakeClaude(dir);
	const bridgeDir = join(dir, "bridge");
	const bridge = await loadBridge({ claudePath: claude, dir: bridgeDir }, () => {});
	assert.ok(bridge.models.length > 0, "the bridge registered its models");
	const settings = JSON.parse(readFileSync(join(bridgeDir, "claude-bridge.json"), "utf8"));
	assert.equal(settings.provider.pathToClaudeCodeExecutable, claude);
	const agent = await import(join(bridgeDir, "pi-coding-agent.mjs"));
	assert.equal(agent.getAgentDir(), bridgeDir);
	assert.equal(typeof agent.loadSkills, "function", "the rest of pi-coding-agent comes through");
});
