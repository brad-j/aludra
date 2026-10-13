import assert from "node:assert/strict";
import { createServer } from "node:net";
import test, { type TestContext } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { stripTerminalSequences, type Terminal } from "@earendil-works/pi-tui";
import { context } from "../src/host.ts";
import { listen, socketPathFor } from "../src/server.ts";
import { runTui } from "../src/tui.ts";
import { makeProject, testHost } from "./helpers.ts";

/** A terminal of a fixed size that draws nowhere; `type` sends it keys. */
function fakeTerminal(columns = 120, rows = 30) {
	let onInput: (data: string) => void = () => {};
	const terminal: Terminal = {
		start: (input) => void (onInput = input),
		stop: () => {},
		drainInput: async () => {},
		write: () => {},
		get columns() {
			return columns;
		},
		get rows() {
			return rows;
		},
		get kittyProtocolActive() {
			return false;
		},
		moveBy: () => {},
		hideCursor: () => {},
		showCursor: () => {},
		clearLine: () => {},
		clearFromCursor: () => {},
		clearScreen: () => {},
		setTitle: () => {},
		setProgress: () => {},
		setProgramStatus: () => {},
	};
	return { terminal, type: (data: string) => onInput(data) };
}

/** Starts the UI against `config`'s host and waits until it's drawing. */
async function openUi(t: TestContext, config: Parameters<typeof runTui>[0], options: { session?: number } = {}) {
	const { terminal, type } = fakeTerminal();
	let ui: { screen: () => string[]; quit: () => void } | undefined;
	const exited = runTui(config, { ...options, terminal, ready: (ready) => (ui = ready) });
	while (ui === undefined) await new Promise((resolve) => setTimeout(resolve, 10));
	t.after(() => ui!.quit());
	const text = () => ui!.screen().map(stripTerminalSequences).join("\n");
	const until = async (what: RegExp, label: string) => {
		const deadline = Date.now() + 5000;
		while (!what.test(text())) {
			if (Date.now() > deadline) assert.fail(`${label} never showed. The screen:\n${text()}`);
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	};
	return { ui: ui!, text, until, type, exited };
}

test("the UI lists sessions by project and follows the selected one's transcript; arrows move between them", async (t) => {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", name: "Faux 1", contextWindow: 200_000 }] });
	faux.setResponses([fauxAssistantMessage(fauxText("The **first** answer.")), fauxAssistantMessage(fauxText("The second answer."))]);
	const models = createModels();
	models.setProvider(faux.provider);
	const { host, dir, config } = await testHost(t, { models, model: { provider: "faux", modelId: "faux-1" } });
	const server = listen(host, socketPathFor(config));
	t.after(() => server.close());

	const older = await host.sessions.create(makeProject(dir, "gaidin"), "what does gaidin do?");
	await (await host.submit(older.id, "what does gaidin do?")).wait(context);
	const newer = await host.sessions.create(makeProject(dir, "aludra"), "and aludra?");
	await (await host.submit(newer.id, "and aludra?")).wait(context);

	const { text, until, type, ui, exited } = await openUi(t, config);
	// The newest project first, each session under it with its mark; the first one is open.
	await until(/The second answer\./, "the newest session's answer");
	const screen = text();
	assert.ok(screen.indexOf("aludra") < screen.indexOf("gaidin"), screen);
	assert.match(screen, /› ✓ and aludra\?/);
	assert.match(screen, /❯ and aludra\?/);
	assert.match(screen, /✓ done · Faux 1 · high/);

	type("\x1b[B");
	await until(/The first answer\./, "the other session's answer, after the down arrow");
	assert.match(text(), /› ✓ what does gaidin do\?/);
	assert.doesNotMatch(text(), /The second answer/);

	type("q");
	assert.equal(await exited, 0);
	void ui;
});

test("--session opens that session first", async (t) => {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	faux.setResponses([fauxAssistantMessage(fauxText("one")), fauxAssistantMessage(fauxText("two"))]);
	const models = createModels();
	models.setProvider(faux.provider);
	const { host, dir, config } = await testHost(t, { models, model: { provider: "faux", modelId: "faux-1" } });
	const server = listen(host, socketPathFor(config));
	t.after(() => server.close());
	const first = await host.sessions.create(makeProject(dir, "a"), "first");
	await (await host.submit(first.id, "first")).wait(context);
	const second = await host.sessions.create(makeProject(dir, "b"), "second");
	await (await host.submit(second.id, "second")).wait(context);

	const { until, text } = await openUi(t, config, { session: first.id });
	await until(/❯ first/, "the asked-for session");
	assert.match(text(), /› ✓ first/);
});

test("a host from before the UI is told apart from one that isn't running", async (t) => {
	const { config } = await testHost(t);
	assert.equal(await runTui(config, { terminal: fakeTerminal().terminal }), 1, "nothing on the socket");

	// What an older host says to a request it doesn't know.
	const old = createServer((socket) => {
		socket.once("data", () => {
			socket.write(`${JSON.stringify({ type: "line", text: "! the request.type should be one of ask, watch" })}\n`);
			socket.end(`${JSON.stringify({ type: "done", status: "failed" })}\n`);
		});
	});
	await new Promise<void>((resolve) => old.listen(socketPathFor(config), resolve));
	t.after(() => old.close());
	const errors: string[] = [];
	const error = console.error;
	console.error = (...args: unknown[]) => void errors.push(args.join(" "));
	try {
		assert.equal(await runTui(config, { terminal: fakeTerminal().terminal }), 1);
	} finally {
		console.error = error;
	}
	assert.match(errors.join("\n"), /older than this aludra.*sh scripts\/install\.sh/);
});
