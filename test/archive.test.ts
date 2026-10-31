import assert from "node:assert/strict";
import test from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import type { SessionSummary } from "../src/api-types.ts";
import { archiveIdle, idleSessions } from "../src/archive.ts";
import { configFor } from "../src/config.ts";
import { context } from "../src/host.ts";
import { makeProject, testHost } from "./helpers.ts";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

function summary(id: number, daysAgo: number, extra: Partial<SessionSummary & { kept: boolean }> = {}): SessionSummary & { kept?: boolean } {
	return { id, workspace: "w", project: "p", dir: "/p", title: "t", createdAt: 0, updatedAt: NOW - daysAgo * DAY, state: "done", line: "", ...extra };
}

test("idle sessions go after the days given: not running, waiting, archived or kept ones, and none when it's off", () => {
	const sessions = [
		summary(1, 0.7),
		summary(2, 2.9),
		summary(3, 3),
		summary(4, 7),
		summary(5, 9, { state: "running" }),
		summary(6, 9, { state: "waiting" }),
		summary(7, 9, { archived: true }),
		summary(8, 9, { kept: true }),
		summary(9, 9, { state: "failed" }),
	];
	assert.deepEqual(idleSessions(sessions, 3, NOW), [3, 4, 9]);
	assert.deepEqual(idleSessions(sessions, 0, NOW), []);
	assert.deepEqual(idleSessions(sessions, 8, NOW), [9]);
});

test("the host archives its idle sessions, tells clients, and leaves one brought back by hand until it's archived again", async (t) => {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	faux.setResponses([fauxAssistantMessage(fauxText("Ok.")), fauxAssistantMessage(fauxText("Ok."))]);
	const models = createModels();
	models.setProvider(faux.provider);
	const { host, dir } = await testHost(t, { models, model: { provider: "faux", modelId: "faux-1" } });
	const project = makeProject(dir, "demo");
	const old = await host.sessions.create(project, "old");
	await (await host.submit(old.id, "old")).wait(context);
	const fresh = await host.sessions.create(project, "fresh");
	await (await host.submit(fresh.id, "fresh")).wait(context);
	const heard: [number, boolean][] = [];
	host.sessions.onUpdate((record) => heard.push([record.id, record.archived === true]));

	// Four days on, both are idle that long.
	const later = Date.now() + 4 * DAY;
	assert.deepEqual(await archiveIdle(host, later), [old.id, fresh.id]);
	assert.deepEqual(heard, [[old.id, true], [fresh.id, true]]);

	// Brought back by hand, it stays; archived again, it's back to the usual rule.
	const back = await host.sessions.archive(old.id, false);
	assert.equal(back.kept, true);
	assert.deepEqual(await archiveIdle(host, later), []);
	await host.sessions.archive(old.id, true);
	await host.sessions.archive(old.id, false);
	assert.equal((await host.sessions.get(old.id))!.kept, true);
	const again = await host.sessions.archive(old.id, true);
	assert.equal(again.kept, undefined);

	// Unarchiving a session that wasn't archived doesn't keep it.
	assert.equal((await host.sessions.archive(fresh.id, false)).kept, true);
	const never = await host.sessions.create(project, "never archived");
	assert.equal((await host.sessions.archive(never.id, false)).kept, undefined);
});

test("archive.afterDays: 3 by default, 0 turns it off, a negative is refused, and clients can change it", async (t) => {
	const workspaces = [{ name: "a", roots: [] }];
	assert.equal(configFor(JSON.stringify({ workspaces }), {}).config.archive.afterDays, 3);
	assert.equal(configFor(JSON.stringify({ workspaces, archive: { afterDays: 0 } }), {}).config.archive.afterDays, 0);
	assert.match(configFor(JSON.stringify({ workspaces, archive: { afterDays: -1 } }), {}).errors.join(), /archive\.afterDays/);

	const { host } = await testHost(t, { settingsFile: true });
	const setting = host.settings.get().settings.find((s) => s.key === "archive.afterDays");
	assert.deepEqual([setting?.value, setting?.editable, setting?.live], [3, true, true]);
	host.settings.set({ "archive.afterDays": 0 });
	assert.equal(host.archiveAfterDays(), 0);
	assert.deepEqual(await archiveIdle(host, Date.now() + 100 * DAY), []);
});
