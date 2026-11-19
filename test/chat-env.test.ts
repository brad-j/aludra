import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { ChatEnv, findBwrap, realOrParent } from "../src/chat-env.ts";
import { tempDir } from "./helpers.ts";

const bwrap = findBwrap();

function setup(t: Parameters<typeof tempDir>[0]) {
	const root = tempDir(t);
	const project = join(root, "project");
	const own = join(root, "chat");
	mkdirSync(project);
	mkdirSync(own);
	writeFileSync(join(project, "a.txt"), "one\n");
	return { root, project, own };
}

test("a chat's file tools read anywhere and write only its own directory, links resolved", async (t) => {
	const { project, own } = setup(t);
	const env = new ChatEnv({ cwd: project, writable: own, bwrap });
	const read = await env.readTextFile("a.txt", ctx);
	assert.ok(read.ok && read.value === "one\n");
	for (const attempt of [
		env.writeFile("a.txt", "two\n", ctx),
		env.writeFile(join(project, "new.txt"), "x", ctx),
		env.appendFile("a.txt", "more", ctx),
		env.remove("a.txt", undefined, ctx),
		env.renameFile("a.txt", join(own, "moved.txt"), ctx),
		env.createDir(join(project, "sub"), undefined, ctx),
		env.writeFile(join(own, "..", "project", "a.txt"), "dotdot", ctx),
	]) {
		const result = await attempt;
		assert.equal(result.ok, false);
		assert.ok(!result.ok && result.error.code === "permission_denied" && /start a task/.test(result.error.message));
	}
	assert.equal(readFileSync(join(project, "a.txt"), "utf8"), "one\n");
	assert.equal(existsSync(join(project, "new.txt")), false);
	// A link in its own directory that points into the project doesn't let a write through.
	symlinkSync(project, join(own, "door"));
	const through = await env.writeFile(join(own, "door", "a.txt"), "via link", ctx);
	assert.equal(through.ok, false);
	assert.equal(readFileSync(join(project, "a.txt"), "utf8"), "one\n");
	const notes = await env.writeFile(join(own, "notes", "today.md"), "fine", ctx);
	assert.ok(notes.ok, "a new file in a new folder of its own");
	assert.equal(readFileSync(join(own, "notes", "today.md"), "utf8"), "fine");
	assert.equal(realOrParent(join(own, "door", "nope", "x")), join(project, "nope", "x"));
});

test("a chat's commands run with the file system read-only but for its own directory", { skip: bwrap === undefined && "no bubblewrap here" }, async (t) => {
	const { project, own } = setup(t);
	const env = new ChatEnv({ cwd: project, writable: own, bwrap });
	const run = async (command: string) => {
		let out = "";
		const result = await env.exec(command, { onOutput: (text) => void (out += text) }, ctx);
		assert.ok(result.ok, result.ok ? "" : result.error.message);
		return { exitCode: result.value.exitCode, out };
	};
	const look = await run("cat a.txt && pwd");
	assert.equal(look.exitCode, 0);
	assert.match(look.out, /^one\n.*project\n$/s);
	const write = await run("echo two > a.txt");
	assert.notEqual(write.exitCode, 0);
	assert.match(write.out, /Read-only file system/);
	assert.notEqual((await run(`touch ${JSON.stringify(join(project, "b.txt"))}`)).exitCode, 0);
	assert.equal((await run(`echo kept > ${JSON.stringify(join(own, "kept.txt"))}`)).exitCode, 0);
	assert.equal((await run("echo scratch > /tmp/scratch && cat /tmp/scratch")).out, "scratch\n", "a /tmp of its own");
	assert.equal(readFileSync(join(project, "a.txt"), "utf8"), "one\n");
	assert.equal(existsSync(join(project, "b.txt")), false);
	assert.equal(readFileSync(join(own, "kept.txt"), "utf8"), "kept\n");
});

test("without bubblewrap a chat runs no commands, and says why", async (t) => {
	const { project, own } = setup(t);
	const env = new ChatEnv({ cwd: project, writable: own, bwrap: undefined });
	const result = await env.exec("echo hi", undefined, ctx);
	assert.ok(!result.ok && result.error.code === "shell_unavailable" && /bubblewrap/.test(result.error.message));
});
