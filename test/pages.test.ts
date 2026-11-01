import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { context } from "../src/host.ts";
import { MAX_PAGE_BYTES, PAGE_CSP, sealPage, withPolicy } from "../src/pages.ts";
import { makeProject, PNG, tempDir, testHost } from "./helpers.ts";

test("the policy goes first in the head, or wraps a fragment in a document", () => {
	const meta = `<meta http-equiv="Content-Security-Policy" content="${PAGE_CSP}">`;
	assert.equal(withPolicy('<html lang="en"><head><title>x</title></head><body>hi</body></html>'), `<html lang="en"><head>${meta}<title>x</title></head><body>hi</body></html>`);
	assert.equal(withPolicy("<html><body>hi</body></html>"), `<html><head>${meta}</head><body>hi</body></html>`);
	assert.equal(withPolicy("<svg></svg>"), `<!doctype html><html><head><meta charset="utf-8">${meta}</head><body><svg></svg></body></html>`);
	assert.match(PAGE_CSP, /default-src 'none'/);
	assert.doesNotMatch(PAGE_CSP, /connect-src|https?:/, "nothing on the network");
});

test("local images are inlined by relative or absolute path; URLs, missing files, non-images and protected paths aren't", async (t) => {
	const dir = tempDir(t);
	mkdirSync(join(dir, "shots"));
	writeFileSync(join(dir, "shots", "before.png"), Buffer.from(PNG, "base64"));
	writeFileSync(join(dir, "notes.txt"), "not an image");
	mkdirSync(join(dir, ".ssh"));
	writeFileSync(join(dir, ".ssh", "id.png"), Buffer.from(PNG, "base64"));
	const html = [
		'<img src="shots/before.png">',
		`<img src='${join(dir, "shots", "before.png")}'>`,
		'<div style="background: url(shots/before.png)"></div>',
		'<img src="https://example.com/x.png">',
		'<img src="data:image/png;base64,AAAA">',
		'<img src="gone.png">',
		'<img src="notes.txt">',
		'<img src=".ssh/id.png">',
	].join("\n");
	const sealed = await sealPage(html, dir);
	assert.equal(sealed.images, 2, "two distinct references, one file");
	assert.equal((sealed.html.match(/data:image\/png;base64,iVBOR/g) ?? []).length, 3);
	assert.ok(sealed.html.includes("https://example.com/x.png"), "a URL is left as it is; the policy blocks it");
	assert.deepEqual(sealed.missing.sort(), [".ssh/id.png", "gone.png", "notes.txt"]);
	assert.ok(sealed.html.startsWith("<!doctype html>"));
});

test("the agent publishes a page: it's sealed and stored with the session, numbered, and fetched over /amyrlin's method", async (t) => {
	let calls = 0;
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	faux.setResponses(Array.from({ length: 10 }, () => (ctx: TranscriptContext) => {
		const last = ctx.messages.at(-1)!;
		if (last.role === "toolResult") return fauxAssistantMessage(fauxText("Here's the chart."));
		calls += 1;
		if (/huge/.test(JSON.stringify(last.content))) return fauxAssistantMessage(fauxToolCall("publish_page", { title: "Huge", html: "x".repeat(MAX_PAGE_BYTES + 1) }), { stopReason: "toolUse" });
		return fauxAssistantMessage(fauxToolCall("publish_page", { title: "Build times", html: '<html><head></head><body><svg width="10"></svg><img src="chart.png"></body></html>' }), { stopReason: "toolUse" });
	}));
	const models = createModels();
	models.setProvider(faux.provider);
	const { host, dir } = await testHost(t, { models, model: { provider: "faux", modelId: "faux-1" } });
	const project = makeProject(dir, "demo");
	writeFileSync(join(project.dir, "chart.png"), Buffer.from(PNG, "base64"));
	const session = await host.sessions.create(project, "chart");
	await (await host.submit(session.id, "chart the build times")).wait(context);
	await (await host.submit(session.id, "and again")).wait(context);

	const first = await host.page(session.id, 1);
	assert.equal(first?.title, "Build times");
	assert.match(first!.html, /^<html><head><meta http-equiv="Content-Security-Policy"/);
	assert.match(first!.html, /src="data:image\/png;base64,/);
	assert.equal(first!.images, 1);
	assert.equal((await host.page(session.id, 2))?.page, 2, "each publish is a new page");
	assert.equal(await host.page(session.id, 3), undefined);
	assert.equal(await host.page(999, 1), undefined);

	// The tool's result says where the page is, for clients reading the transcript.
	const view = await (await host.conversation(session.id)).viewState(context);
	const result = view.value.entries.flatMap((e) => e.model ?? []).find((m) => m.role === "toolResult" && m.toolName === "publish_page");
	view.dispose();
	assert.deepEqual((result as { details?: unknown }).details, { page: 1, title: "Build times", bytes: Buffer.byteLength(first!.html) });

	// Too big: an error to the model, nothing stored.
	await (await host.submit(session.id, "a huge one")).wait(context);
	assert.equal(await host.page(session.id, 3), undefined);
	const after = await (await host.conversation(session.id)).viewState(context);
	const refused = after.value.entries.flatMap((e) => e.model ?? []).filter((m) => m.role === "toolResult" && m.toolName === "publish_page").at(-1) as { isError?: boolean; content: { text?: string }[] };
	after.dispose();
	assert.equal(refused.isError, true);
	assert.match(refused.content[0]!.text ?? "", /limit is 5 MB/);
	assert.ok(calls >= 3);
});
