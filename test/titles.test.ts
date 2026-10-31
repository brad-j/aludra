import assert from "node:assert/strict";
import test from "node:test";
import type { SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { configFor } from "../src/config.ts";
import { context, Sessions } from "../src/host.ts";
import { cleanTitle, excerptOf, modelTitler, RETITLE_PROMPT, TITLE_PROMPT, titleModels } from "../src/titles.ts";
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

test("an excerpt for a title keeps the first message and the latest ones that fit", () => {
	assert.equal(excerptOf([]), "");
	assert.equal(excerptOf([{ from: "user", text: "Fix  the\nbuild" }, { from: "agent", text: "Fixed." }]), "User: Fix the build\nAgent: Fixed.");
	const many = Array.from({ length: 50 }, (_, i) => ({ from: (i % 2 === 0 ? "user" : "agent") as "user" | "agent", text: `message ${i} ${"x".repeat(100)}` }));
	const excerpt = excerptOf(many, 1000);
	const lines = excerpt.split("\n");
	assert.ok(excerpt.length <= 1000 + 30, String(excerpt.length));
	assert.match(lines[0]!, /^User: message 0 /);
	assert.match(lines[1]!, /^\(\d+ more left out\)$/);
	assert.match(lines.at(-1)!, /^Agent: message 49 /);
	assert.ok(excerptOf([{ from: "agent", text: "y".repeat(5000) }]).length < 1300, "one long answer is cut");
});

test("a conversation title goes to the model with the retitle prompt", async () => {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	const contexts: TranscriptContext[] = [];
	faux.setResponses([(ctx: TranscriptContext) => {
		contexts.push(ctx);
		return fauxAssistantMessage(fauxText("Where it went"));
	}]);
	const models = createModels();
	models.setProvider(faux.provider);
	const title = await modelTitler(models, [{ provider: "faux", modelId: "faux-1" }], () => {})("User: a\nAgent: b", { conversation: true });
	assert.equal(title, "Where it went");
	assert.match(JSON.stringify(contexts[0]!.messages), new RegExp(JSON.stringify(RETITLE_PROMPT.split("\n")[0]).slice(1, 60)));
	assert.match(JSON.stringify(contexts[0]!.messages), /<conversation>\\nUser: a\\nAgent: b\\n<\/conversation>/);
});

test("regenerating a title reads the whole conversation, replaces a title set by hand, and loses to a rename made meanwhile", async (t) => {
	const pending: ((title: string | undefined) => void)[] = [];
	const asked: string[] = [];
	const titler = (text: string, options?: { conversation?: boolean }) => {
		if (options?.conversation !== true) return Promise.resolve(undefined);
		asked.push(text);
		return new Promise<string | undefined>((resolve) => pending.push(resolve));
	};
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	faux.setResponses([fauxAssistantMessage(fauxText("First answer")), fauxAssistantMessage(fauxText("Second answer"))]);
	const models = createModels();
	models.setProvider(faux.provider);
	const { host, dir } = await testHost(t, { models, model: { provider: "faux", modelId: "faux-1" }, titler });
	const project = makeProject(dir, "demo");
	const session = await host.sessions.create(project, "Start");
	await (await host.submit(session.id, "Start here")).wait(context);
	await (await host.submit(session.id, "Then this")).wait(context);
	await host.sessions.rename(session.id, "By hand");

	const written = host.sessions.regenerateTitle(session.id);
	while (pending.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(asked[0], "User: Start here\nAgent: First answer\nUser: Then this\nAgent: Second answer");
	pending[0]!("Then this, after starting");
	const record = await written;
	assert.equal(record?.title, "Then this, after starting");
	assert.equal(record?.titled, "model");

	// A rename while the model writes wins.
	const raced = host.sessions.regenerateTitle(session.id);
	while (pending.length === 1) await new Promise((resolve) => setTimeout(resolve, 5));
	await host.sessions.rename(session.id, "Renamed meanwhile");
	pending[1]!("Too late");
	assert.equal(await raced, undefined);
	assert.equal((await host.sessions.get(session.id))!.title, "Renamed meanwhile");

	const empty = await host.sessions.create(project, "New session");
	await assert.rejects(host.sessions.regenerateTitle(empty.id), /no messages/);
	await assert.rejects(host.sessions.regenerateTitle(999), /no session 999/);
});
