import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Connection, localDaemon } from "@earendil-works/pi-env";
import { context } from "../src/host.ts";
import { createOrbs, templateName } from "../src/orbs.ts";

test("an orb's connection opens on first use, stays open while a command runs, and closes once idle", async () => {
	const dir = mkdtempSync(join(tmpdir(), "aludra-orbs-"));
	const opened: number[] = [];
	// pi-env's daemon on this machine stands in for an orb: the same protocol, without SSH.
	const host = { ssh: "unused", gateKey: "/dev/null", hostKnownHosts: "/dev/null", orbKey: "/dev/null", orbHostKey: "ssh-ed25519 AAAA", dataDir: dir };
	const orbs = createOrbs(host, {
		idleMs: 300,
		connect: (n) => {
			opened.push(n);
			return new Connection({ command: [localDaemon()] });
		},
	});
	try {
		assert.equal(orbs.connected(3), false);
		const env = orbs.env(3, dir);
		assert.equal(orbs.connected(3), true, "an environment holds a connection");

		// A command longer than the idle time keeps the connection open.
		let out = "";
		const result = await env.exec("sleep 0.6 && echo done", { onOutput: (t) => (out += t) }, context);
		assert.ok(result.ok && result.value.exitCode === 0);
		assert.equal(out.trim(), "done");
		assert.equal(orbs.connected(3), true, "still open right after the command");

		await new Promise((resolve) => setTimeout(resolve, 500));
		assert.equal(orbs.connected(3), false, "closed after the idle time with nothing in flight");

		// The next use opens a new connection.
		const again = orbs.env(3, dir);
		assert.ok((await again.writeFile("x.txt", "hello", context)).ok);
		assert.deepEqual(opened, [3, 3]);
	} finally {
		orbs.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("template names are safe for stedding and follow the commit", () => {
	assert.equal(templateName("raken", "0123456789abcdef0123"), "raken-0123456789ab");
	assert.equal(templateName("my project!", "abc"), "my-project--abc");
	assert.equal(templateName(".hidden", "abc"), "phidden-abc");
	assert.match(templateName("a b/c", "f00"), /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
});

test("without an orb host, orbs refuse to make one", async () => {
	const orbs = createOrbs(undefined);
	assert.equal(orbs.configured(), false);
	await assert.rejects(orbs.create(), /no orb host/);
});
