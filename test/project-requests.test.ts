import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import test from "node:test";
import { describeProjectRequest, openProjectRequests } from "../src/project-requests.ts";
import { tempDir } from "./helpers.ts";

test("a request file from before plans gains the plan column, and its requests read without one", (t) => {
	const file = join(tempDir(t), "project-requests.sqlite");
	const old = new DatabaseSync(file);
	old.exec(`CREATE TABLE requests (id TEXT PRIMARY KEY, token INTEGER NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('create', 'promote')), name TEXT NOT NULL, description TEXT, session INTEGER, status TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, decided_at INTEGER, dir TEXT, error TEXT, reported INTEGER NOT NULL DEFAULT 0)`);
	old.prepare("INSERT INTO requests (id, token, kind, name, status, created_at, expires_at) VALUES ('abc123', 1, 'create', 'waygate', 'pending', ?, ?)").run(Date.now(), Date.now() + 3_600_000);
	old.close();

	const requests = openProjectRequests(file, () => 3_600_000);
	t.after(() => requests.close());
	const kept = requests.get("abc123");
	assert.equal(kept?.name, "waygate");
	assert.equal(kept?.plan, undefined);
	const seeded = requests.open(1, "create", "portal", "Stones.", undefined, { steps: ["Map them"], questions: ["Which first?"] });
	assert.deepEqual(requests.get(seeded.id)?.plan, { steps: ["Map them"], questions: ["Which first?"] });
	assert.equal(describeProjectRequest(seeded), "make project portal: Stones. (plan: 1 step, 1 question)");
});
