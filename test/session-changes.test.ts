import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { openSessionChanges } from "../src/session-changes.ts";
import { tempDir } from "./helpers.ts";

test("the change journal: sessions from before it aren't new, running wakes nothing, and what was seen and each cursor last across a reopen", (t) => {
	const file = join(tempDir(t), "session-changes.sqlite");
	const old = Date.now() - 60_000;
	let changes = openSessionChanges(file);
	const madeAt = Date.now();
	changes.observe([{ id: 1, state: "done", updatedAt: old }]);
	assert.deepEqual(changes.pending(7, 0), [], "a session last updated before the file was made");

	changes.observe([{ id: 1, state: "running", updatedAt: madeAt + 1 }, { id: 2, state: "idle", updatedAt: madeAt + 1 }]);
	assert.deepEqual(changes.pending(7, 0).map((c) => [c.session, c.from, c.to]), [[2, null, "idle"]], "running on its own is noted, not a change");
	changes.observe([{ id: 1, state: "running", updatedAt: madeAt + 1 }]);
	assert.equal(changes.pending(7, 0).length, 1, "nothing new, nothing added");
	changes.close();

	// After a restart, a session that ended meanwhile reads from what was seen before.
	changes = openSessionChanges(file);
	t.after(() => changes.close());
	changes.observe([{ id: 1, state: "done", updatedAt: madeAt + 2 }]);
	const all = changes.pending(7, 0);
	assert.deepEqual(all.map((c) => [c.session, c.from, c.to]), [[2, null, "idle"], [1, "running", "done"]]);
	// An older summary than the one seen is ignored.
	changes.observe([{ id: 1, state: "running", updatedAt: madeAt + 1 }]);
	assert.equal(changes.pending(7, 0).length, 2);

	assert.deepEqual(changes.markHandled(7, all[0]!.change), { through: all[0]!.change });
	assert.deepEqual(changes.pending(7, 0).map((c) => c.session), [1]);
	assert.equal(changes.pending(8, 0).length, 2, "another token's cursor is its own");
	assert.equal(changes.pending(9, madeAt + 2).length, 1, "a token made later gets only what was updated since");
});
