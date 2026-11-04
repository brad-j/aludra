import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Connection, localDaemon } from "@earendil-works/pi-env";
import { context } from "../src/host.ts";
import { createOrbs } from "../src/orbs.ts";

// pi-env's daemon on this machine stands in for an orb: the same protocol, without SSH.
const target = { host: "unused", knownHostsFile: "/dev/null", hostKeyAlias: "unused" };

test("an orb's connection opens on first use, stays open while a command runs, and closes once idle", async () => {
	const dir = mkdtempSync(join(tmpdir(), "aludra-orbs-"));
	const opened: string[] = [];
	const orbs = createOrbs({ a: target }, {
		idleMs: 300,
		connect: (name) => {
			opened.push(name);
			return new Connection({ command: [localDaemon()] });
		},
	});
	try {
		assert.equal(orbs.connected("a"), false);
		const env = orbs.env("a", dir);
		assert.equal(orbs.connected("a"), true, "an environment holds a connection");

		// A command longer than the idle time keeps the connection open.
		let out = "";
		const result = await env.exec("sleep 0.6 && echo done", { onOutput: (t) => (out += t) }, context);
		assert.ok(result.ok && result.value.exitCode === 0);
		assert.equal(out.trim(), "done");
		assert.equal(orbs.connected("a"), true, "still open right after the command");

		await new Promise((resolve) => setTimeout(resolve, 500));
		assert.equal(orbs.connected("a"), false, "closed after the idle time with nothing in flight");

		// The next use opens a new connection.
		const again = orbs.env("a", dir);
		assert.ok((await again.writeFile("x.txt", "hello", context)).ok);
		assert.deepEqual(opened, ["a", "a"]);
		assert.throws(() => orbs.env("b", dir), /no orb named b/);
	} finally {
		orbs.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
