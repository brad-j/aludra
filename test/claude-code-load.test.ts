// The real pi-claude-code, loaded the way the host loads it. Loading starts no Claude Code process.
import assert from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { claudeCodeProvider, claudeExecutable, findExecutable, loadClaudeCode, PROVIDER } from "../src/claude-code.ts";
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

test("pi-claude-code loads, runs the configured Claude Code, and offers Claude's models under aludra's ID", async (t) => {
	const dir = tempDir(t);
	const claude = fakeClaude(dir);
	const inner = await loadClaudeCode(claude);
	assert.equal(process.env.PI_CLAUDE_CODE_COMMAND, claude);
	const ids = claudeCodeProvider(inner).provider.getModels().map((m) => `${m.provider}/${m.id}`);
	assert.ok(ids.includes(`${PROVIDER}/claude-opus-5-5`), ids.join(", "));
	assert.ok(!ids.includes(`${PROVIDER}/default`));
});
