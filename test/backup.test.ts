import assert from "node:assert/strict";
import { readdirSync, statSync } from "node:fs";
import test from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { DatabaseSync } from "node:sqlite";
import { backupDue, backupNow, listBackups } from "../src/backup.ts";
import { context } from "../src/host.ts";
import { fakeBridge, makeProject, testHost } from "./helpers.ts";

const tables = (file: string) => {
	const db = new DatabaseSync(file, { readOnly: true });
	try {
		const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => String(row.name));
		return Object.fromEntries(names.map((name) => [name, Number(db.prepare(`SELECT count(*) AS n FROM "${name}"`).get()!.n)]));
	} finally {
		db.close();
	}
};

test("a backup taken while the host runs holds what the database does, and only the newest are kept", async (t) => {
	const { bridge } = fakeBridge([fauxAssistantMessage("hi")]);
	const { host, dir, config } = await testHost(t, { bridge });
	const project = makeProject(dir, "one");
	const session = await host.sessions.create(project, "first");
	await (await host.submit(session.id, "hello")).wait(context);
	const backup = { ...config, backup: { ...config.backup, keep: 2 } };

	assert.equal(backupDue(backup), true, "due with none");
	const first = await backupNow(backup, new Date("2026-10-13T10:00:00Z"));
	assert.match(first, /aludra-20261013T100000Z\.sqlite$/);
	assert.equal(statSync(first).mode & 0o777, 0o600, "only the owner can read it");
	const counts = tables(first);
	assert.ok(Object.keys(counts).length > 0, "the copy has the tables");
	assert.deepEqual(counts, tables(`${config.dataDir}/aludra.sqlite`), "and the same rows");

	assert.equal(backupDue(backup, new Date("2026-10-13T20:00:00Z")), false, "not due ten hours later");
	assert.equal(backupDue(backup, new Date("2026-10-14T10:00:00Z")), true, "due a day later");
	await backupNow(backup, new Date("2026-10-14T10:00:00Z"));
	await backupNow(backup, new Date("2026-10-15T10:00:00Z"));
	assert.deepEqual(listBackups(backup.backup.dir).map((b) => b.at.toISOString()), ["2026-10-15T10:00:00.000Z", "2026-10-14T10:00:00.000Z"]);
	assert.deepEqual(readdirSync(backup.backup.dir).filter((f) => f.endsWith(".partial")), [], "no partial files left");
});
