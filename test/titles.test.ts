import assert from "node:assert/strict";
import test from "node:test";
import type { SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { configFor } from "../src/config.ts";
import { context, Sessions } from "../src/host.ts";
import { cleanTitle, modelTitler, TITLE_PROMPT, titleModels } from "../src/titles.ts";
import { makeProject, testHost } from "./helpers.ts";

test("a model's reply is cut down to a title", () => {
	assert.equal(cleanTitle("Fix flaky login test"), "Fix flaky login test");
	assert.equal(cleanTitle('  "Keyboard shortcuts and idea fixes."  \n\nMore text'), "Keyboard shortcuts and idea fixes");
	assert.equal(cleanTitle("Title: **Rename the session cookie**"), "Rename the session cookie");
	assert.equal(cleanTitle("\n  \n"), undefined);
	const long = cleanTitle("word ".repeat(40))!;
	assert.ok(long.length <= 81 && long.endsWith("…"), long);
});

test("titles come from the smallest model on hand, one-off, and the next one is tried when one fails", async () => {
	const claude = fauxProvider({ provider: "claude-bridge", models: [{ id: "claude-opus-5-5" }, { id: "claude-haiku-5-5" }] });
	const asked: { model: string; context: TranscriptContext; options?: SimpleStreamOptions }[] = [];
	const streamSimple = claude.provider.streamSimple;
	claude.provider.streamSimple = (model, ctx, options) => {
		asked.push({ model: model.id, context: ctx, ...(options === undefined ? {} : { options }) });
		return streamSimple(model, ctx, options);
	};
	claude.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "rate limited" }), fauxAssistantMessage(fauxText("Login test fix"))]);
	const models = createModels();
	models.setProvider(claude.provider);
	const { config } = configFor(JSON.stringify({ workspaces: [{ name: "a", roots: [] }] }), {});

	const candidates = titleModels(models, config);
	assert.deepEqual(candidates.map((c) => c.modelId), ["claude-haiku-5-5", "claude-opus-5-5"]);
	const logged: string[] = [];
	const title = await modelTitler(models, candidates, (m) => logged.push(m))("Can you look at why the login test fails?");
	assert.equal(title, "Login test fix");
	assert.deepEqual(asked.map((a) => a.model), ["claude-haiku-5-5", "claude-opus-5-5"]);
	assert.match(logged[0]!, /haiku.*rate limited/);
	assert.equal(asked[0]!.options?.cacheRetention, "none");
	assert.match(JSON.stringify(asked[0]!.context), new RegExp(JSON.stringify(TITLE_PROMPT.split("\n")[0]).slice(1, 40)));
	assert.match(JSON.stringify(asked[0]!.context), /<message>\\nCan you look at why the login test fails\?\\n<\/message>/);
});

test("a session's first message names it in the background; a rename wins over a title that comes later", async (t) => {
	const titles = new Map<string, (title: string | undefined) => void>();
	const titler = (text: string) => new Promise<string | undefined>((resolve) => titles.set(text, resolve));
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	faux.setResponses([fauxAssistantMessage(fauxText("one")), fauxAssistantMessage(fauxText("two")), fauxAssistantMessage(fauxText("three"))]);
	const models = createModels();
	models.setProvider(faux.provider);
	const { host, dir } = await testHost(t, { models, model: { provider: "faux", modelId: "faux-1" }, titler });
	const project = makeProject(dir, "demo");
	const heard: string[] = [];
	host.sessions.onUpdate((record) => heard.push(record.title));

	const message = "A couple of features I thought of.\n1. Keyboard shortcuts\n2. Fix ideas";
	const named = await host.sessions.create(project, "A couple of features I thought of.");
	await (await host.submit(named.id, message)).wait(context);
	titles.get(message)!("Keyboard shortcuts and idea fixes");
	while ((await host.sessions.get(named.id))!.titled === undefined) await new Promise((resolve) => setTimeout(resolve, 10));
	assert.deepEqual(await host.sessions.get(named.id), { ...(await host.sessions.get(named.id))!, title: "Keyboard shortcuts and idea fixes", titled: "model" });
	assert.deepEqual(heard, ["Keyboard shortcuts and idea fixes"]);

	// Only the first message names a session.
	await (await host.submit(named.id, "And another thing")).wait(context);
	assert.equal(titles.has("And another thing"), false);

	const renamed = await host.sessions.create(project, "fix it");
	await (await host.submit(renamed.id, "fix it")).wait(context);
	await host.sessions.rename(renamed.id, "Mine");
	titles.get("fix it")!("Model's title");
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.deepEqual([(await host.sessions.get(renamed.id))!.title, (await host.sessions.get(renamed.id))!.titled], ["Mine", "user"]);
});

test("retitle names the sessions that still have their first line, and leaves the ones someone renamed", async (t) => {
	let titling = false;
	const titler = async (text: string) => (titling ? `Named: ${text.split(" ")[0]}` : undefined);
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	faux.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage(fauxText("ok"))));
	const models = createModels();
	models.setProvider(faux.provider);
	const { host, dir } = await testHost(t, { models, model: { provider: "faux", modelId: "faux-1" }, titler });
	const project = makeProject(dir, "demo");
	const start = async (text: string) => {
		const session = await host.sessions.create(project, text.split("\n")[0]!);
		await (await host.submit(session.id, text)).wait(context);
		return session;
	};
	// As before titles were written: the first line stands, with no titler to replace it.
	const plain = await start("Why does the build fail?\nIt broke on Tuesday.");
	const byHand = await start("Look at the logs");
	await host.sessions.rename(byHand.id, "Logs");
	const old = await start("Something old");
	// Renamed before who titled was kept: a title that isn't the first line.
	await host.root.commit(async (tx) => {
		(await tx.doc(Sessions)).sessions[String(old.id)]!.title = "Picked long ago";
	}, context);
	const empty = await host.sessions.create(project, "New session");

	titling = true;
	const seen: [number, string | undefined][] = [];
	await host.sessions.retitle((before, after) => seen.push([before.id, after?.title]));
	assert.deepEqual(seen, [[plain.id, "Named: Why"]]);
	assert.equal((await host.sessions.get(plain.id))!.titled, "model");
	assert.equal((await host.sessions.get(byHand.id))!.title, "Logs");
	assert.equal((await host.sessions.get(old.id))!.title, "Picked long ago");
	assert.equal((await host.sessions.get(empty.id))!.title, "New session");

	// Run again, it finds nothing left.
	const again: number[] = [];
	await host.sessions.retitle((before) => again.push(before.id));
	assert.deepEqual(again, []);
});
