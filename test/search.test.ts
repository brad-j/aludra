import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { configFor } from "../src/config.ts";
import { context, openHost } from "../src/host.ts";
import { ftsQuery, messagesOf, openSearch } from "../src/search.ts";
import { makeProject, tempDir, testHost } from "./helpers.ts";

test("a query becomes quoted FTS5 terms, the last a prefix, so no input is a syntax error", () => {
	assert.equal(ftsQuery("login test"), '"login" "test"*');
	assert.equal(ftsQuery('  "NEAR(a b)" OR * -x '), '"near" "a" "b" "or" "x"*');
	assert.equal(ftsQuery("  ...  "), undefined);
	assert.equal(ftsQuery("café"), '"café"*');
});

test("only user messages and answers are indexed, without video or restore notes", () => {
	const user = messagesOf({ id: 3, conversationId: 7, kind: "pi.user", model: [{ role: "user", timestamp: 1, content: [{ type: "text", text: '<restored checkpoint="1">files went back</restored>' }, { type: "text", text: "Fix it" }, { type: "text", text: '<video name="a">note</video>' }] }] });
	assert.deepEqual(user.map((m) => [m.from, m.text]), [["user", "Fix it"]]);
	assert.deepEqual(messagesOf({ id: 4, conversationId: 7, kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: "x", toolName: "bash", content: [{ type: "text", text: "secret output" }], isError: false, timestamp: 2 }] }), []);
	const answer = messagesOf({ id: 5, conversationId: 7, kind: "pi.assistant", model: [fauxAssistantMessage([fauxText("Done, "), fauxToolCall("bash", { command: "ls" }), fauxText("and fixed.")])] });
	assert.deepEqual(answer.map((m) => [m.from, m.text]), [["agent", "Done, \nand fixed."]]);
});

test("the index ranks matches, stems words, matches the last word as a prefix, filters by session and skips repeats", (t) => {
	const index = openSearch(join(tempDir(t), "search.sqlite"));
	t.after(() => index.close());
	index.add([
		{ session: 7, entry: 1, index: 0, from: "user", at: 1, text: "Why do the login tests keep failing?" },
		{ session: 7, entry: 2, index: 0, from: "agent", at: 2, text: "The login test was flaky because of a timeout." },
		{ session: 8, entry: 3, index: 0, from: "user", at: 3, text: "Deploy the site" },
	]);
	index.add([{ session: 7, entry: 1, index: 0, from: "user", at: 1, text: "Why do the login tests keep failing?" }]);
	const hits = index.search("login test");
	assert.equal(hits.length, 2, "stemmed: tests and test both match, and the repeat isn't indexed twice");
	assert.match(hits[0]!.snippet, /«login» «test/);
	assert.equal(hits[0]!.item, `e${hits[0]!.entry}:0`);
	assert.deepEqual(index.search("dep").map((h) => h.session), [8], "the last word is a prefix");
	assert.deepEqual(index.search("login", { session: 8 }), []);
	assert.deepEqual(index.search("   "), []);
	index.reset();
	assert.deepEqual(index.search("login"), []);
});

test("the host indexes messages as they come, finds them across sessions, and catches up after a restart", async (t) => {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	faux.setResponses(Array.from({ length: 10 }, (_, i) => fauxAssistantMessage(fauxText(i === 0 ? "The flaky timeout is in the retry loop." : "Ok."))));
	const models = createModels();
	models.setProvider(faux.provider);
	const { host, dir, config } = await testHost(t, { models, model: { provider: "faux", modelId: "faux-1" } });
	const project = makeProject(dir, "demo");
	const one = await host.sessions.create(project, "flaky");
	await (await host.submit(one.id, "Why is the login test flaky?")).wait(context);
	const two = await host.sessions.create(project, "deploy");
	await (await host.submit(two.id, "Deploy the site")).wait(context);
	await host.sessions.archive(two.id, true);

	const hits = await host.search("flaky");
	assert.deepEqual(hits.map((h) => [h.session, h.from]).sort(), [[one.id, "agent"], [one.id, "user"]]);
	assert.equal(hits[0]!.title, "flaky");
	assert.equal(hits[0]!.project, "demo");
	assert.deepEqual((await host.search("deploy")).map((h) => [h.session, h.archived]), [[two.id, true]], "archived sessions are found, and say so");
	assert.deepEqual(await host.search("flaky", { session: two.id }), []);

	// Messages that land while the host is down, as far as the index knows: a host opened without it.
	await host.close();
	const { rmSync } = await import("node:fs");
	rmSync(join(config.dataDir, "search.sqlite"));
	const agentDir = join(dir, "agent2");
	mkdirSync(agentDir);
	const { config: again } = configFor(JSON.stringify({ dataDir: config.dataDir, workspaces: config.workspaces }), {});
	const reopened = await openHost({ config: again, agentDir, models, model: { provider: "faux", modelId: "faux-1" } });
	t.after(() => reopened.close());
	reopened.resume();
	assert.equal((await reopened.search("login")).length, 1, "the rebuilt index has the old messages");
	assert.equal(await reopened.reindex() >= 3, true);
	assert.equal((await reopened.search("retry loop")).length, 1);
});
