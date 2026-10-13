// `aludra` with no command: a read-only terminal UI. Sessions by project on the left, as the app's drawer orders them;
// the selected session's transcript on the right, following new output as it streams; its state, model and context in
// the line at the foot. It's a client of the host's live feed (src/live.ts) over the CLI's socket, so it shows what the
// web app shows, and nothing it does changes a session.
import { connect, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { type Component, Container, getTerminalColorMode, HStack, Key, Markdown, type MarkdownTheme, matchesKey, ProcessTerminal, ScrollView, type Terminal, truncateToWidth, TuiAltScreen, visibleWidth, VStack, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Item, ServerEvent, SessionMeta, SessionSummary } from "./api-types.ts";
import type { Config } from "./config.ts";
import { age, groupSessions, markOf, NO_PROJECT, pen, shortPath } from "./listing.ts";
import { parseServerMessage, socketPathFor } from "./server.ts";

type Paint = ReturnType<typeof pen>;
type Colors = Readonly<Record<string, number>>;

/** Only fits: every line a component renders must be within the width it's given. */
const fit = (text: string, width: number) => truncateToWidth(text, Math.max(0, width), "…");

/** The sessions, grouped and ordered as the drawer does, with the selected one marked. */
class SessionTree implements Component {
	sessions: SessionSummary[] = [];
	colors: Colors = {};
	selected: number | undefined;
	private readonly paint: Paint;
	constructor(paint: Paint) {
		this.paint = paint;
	}

	/** The sessions in the order they're shown, for moving the selection. */
	order(): SessionSummary[] {
		return groupSessions(this.sessions).flat();
	}

	/** The row session `id` is on, to keep it in view. */
	rowOf(id: number): number {
		let row = 0;
		for (const [i, group] of groupSessions(this.sessions).entries()) {
			row += i === 0 ? 1 : 2;
			for (const s of group) {
				if (s.id === id) return row;
				row += 1;
			}
		}
		return 0;
	}

	render(width: number): string[] {
		const { paint } = this;
		if (this.sessions.length === 0) return [paint.ink("dim", fit("No sessions yet.", width))];
		const now = Date.now();
		const lines: string[] = [];
		for (const group of groupSessions(this.sessions)) {
			const first = group[0]!;
			if (lines.length > 0) lines.push("");
			const folder = first.project === NO_PROJECT ? "scratch" : (first.dir.split("/").at(-2) ?? "");
			lines.push(fit(`${paint.project(first.project, this.colors, first.project)} ${paint.ink("dim", folder)}`, width));
			for (const s of group) {
				const selected = s.id === this.selected;
				const when = age(s.updatedAt, now);
				// "› ◆ title   5h": the pointer marks the selection where there's no color to wash it.
				const room = width - 4 - when.length - 1;
				const title = fit(s.title, room);
				const gap = " ".repeat(Math.max(1, width - 4 - visibleWidth(title) - when.length));
				const row = `${selected ? "›" : " "} ${markOf(paint, s.state)} ${selected ? paint.bold(title) : title}${gap}${paint.ink("dim", when)}`;
				lines.push(selected ? paint.wash(s.project, this.colors, row) : row);
			}
		}
		return lines;
	}

	invalidate(): void {}
}

/** The open session's title and where it runs, above its transcript. */
class Header implements Component {
	summary: SessionSummary | undefined;
	colors: Colors = {};
	private readonly paint: Paint;
	constructor(paint: Paint) {
		this.paint = paint;
	}
	render(width: number): string[] {
		const s = this.summary;
		if (s === undefined) return [this.paint.ink("dim", fit("No session selected.", width)), ""];
		const where = s.project === NO_PROJECT ? "no project · scratch" : `${s.project} · ${shortPath(s.dir)}`;
		return [fit(this.paint.bold(s.title), width), fit(`${this.paint.project(s.project, this.colors, String(s.id))} ${this.paint.ink("dim", where)}`, width), ""];
	}
	invalidate(): void {}
}

/** A message of yours: a violet edge and the ❯, as the app frames them. */
class UserBlock implements Component {
	private readonly paint: Paint;
	private readonly item: Extract<Item, { kind: "user" }>;
	constructor(paint: Paint, item: Extract<Item, { kind: "user" }>) {
		this.paint = paint;
		this.item = item;
	}
	render(width: number): string[] {
		const edge = this.paint.ink("accent", "▎");
		const body = wrapTextWithAnsi(this.item.text.trim() || " ", Math.max(1, width - 4));
		const images = (this.item.images ?? []).map(() => this.paint.ink("dim", "[image]"));
		return [...body, ...images].map((line, i) => `${edge}${i === 0 ? this.paint.ink("accent", "❯ ") : "  "}${line}`);
	}
	invalidate(): void {}
}

/** One line per tool call; a running call shows the tail of its output. */
class CallLine implements Component {
	private readonly paint: Paint;
	private readonly item: Extract<Item, { kind: "call" }>;
	constructor(paint: Paint, item: Extract<Item, { kind: "call" }>) {
		this.paint = paint;
		this.item = item;
	}
	render(width: number): string[] {
		const { paint, item } = this;
		const mark = item.status === "running" ? paint.ink("accent", "◐") : item.status === "error" ? paint.ink("bad", "⊘") : item.status === "done" ? paint.ink("dim", "✓") : paint.ink("dim", "·");
		const { command, path } = item.args;
		const label = typeof command === "string" ? command.split("\n")[0]! : typeof path === "string" ? path : JSON.stringify(item.args);
		const took = item.ms === undefined ? "" : item.ms < 60_000 ? `${(item.ms / 1000).toFixed(item.ms < 10_000 ? 1 : 0)}s` : `${Math.floor(item.ms / 60_000)}m ${Math.round((item.ms % 60_000) / 1000)}s`;
		const head = fit(`${mark} ${paint.ink("dim", item.tool)} ${label}`, width - took.length - 1);
		const lines = [`${head}${" ".repeat(Math.max(1, width - visibleWidth(head) - took.length))}${paint.ink("dim", took)}`];
		if (item.status === "running" && item.output) {
			for (const line of item.output.trimEnd().split("\n").slice(-6)) lines.push(paint.ink("dim", fit(`  ${line}`, width)));
		}
		return lines;
	}
	invalidate(): void {}
}

/** Text lines, cut to the width; for failures and markers. */
class Lines implements Component {
	private readonly lines: string[];
	constructor(lines: string[]) {
		this.lines = lines;
	}
	render(width: number): string[] {
		return this.lines.flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)));
	}
	invalidate(): void {}
}

const FAILURE_TITLE = { refused: "Refused by the model's safeguards", "rate-limit": "Rate limited", stopped: "Stopped", error: "The request failed" } as const;

/** The transcript: each item made once and kept, so an answer streaming in only re-renders itself. */
class Transcript extends Container {
	private made = new Map<string, { json: string; component: Component }>();
	private readonly theme: MarkdownTheme;
	private readonly paint: Paint;
	constructor(paint: Paint) {
		super();
		this.paint = paint;
		const sgr = (on: string, off: string) => (text: string) => `\x1b[${on}m${text}\x1b[${off}m`;
		this.theme = {
			heading: (text) => paint.bold(text),
			link: (text) => paint.ink("accent", text),
			linkUrl: (text) => paint.ink("dim", text),
			code: (text) => paint.color([0.82, 0.08, 190], text),
			codeBlock: (text) => text,
			codeBlockBorder: (text) => paint.ink("dim", text),
			quote: (text) => paint.ink("dim", text),
			quoteBorder: (text) => paint.ink("dim", text),
			hr: (text) => paint.ink("dim", text),
			listBullet: (text) => paint.ink("dim", text),
			bold: sgr("1", "22"),
			italic: sgr("3", "23"),
			strikethrough: sgr("9", "29"),
			underline: sgr("4", "24"),
		};
	}

	set(items: readonly Item[], meta: SessionMeta | undefined) {
		const next = new Map<string, { json: string; component: Component }>();
		const children: Component[] = [];
		let previous: Item["kind"] | undefined;
		for (const item of items) {
			const json = JSON.stringify(item);
			let made = this.made.get(item.id);
			if (made === undefined || made.json !== json) {
				if (made !== undefined && item.kind === "answer" && made.component instanceof Markdown) {
					made.component.setText(item.text);
					made = { json, component: made.component };
				} else {
					made = { json, component: this.make(item) };
				}
			}
			next.set(item.id, made);
			// A blank line between things, but a round of calls stays together.
			if (previous !== undefined && !(previous === "call" && item.kind === "call")) children.push(new Lines([""]));
			children.push(made.component);
			previous = item.kind;
		}
		for (const queued of meta?.queued ?? []) children.push(new Lines(["", this.paint.ink("dim", `queued ${queued.mode === "steer" ? "steer" : "follow-up"}: ${queued.text}`)]));
		if (meta?.approval !== undefined) {
			children.push(new Lines(["", this.paint.ink("wait", `◆ Wants to run ${meta.approval.summary}: ${meta.approval.command}`), this.paint.ink("dim", "  Answer in the app, or run:"), this.paint.ink("dim", `  aludra approve ${meta.approval.id}   or   aludra deny ${meta.approval.id}`)]));
		}
		this.made = next;
		this.clear();
		for (const child of children) super.addChild(child);
	}

	private make(item: Item): Component {
		const { paint } = this;
		switch (item.kind) {
			case "user":
				return new UserBlock(paint, item);
			case "answer":
				return new Markdown(item.text, 0, 0, this.theme);
			case "call":
				return new CallLine(paint, item);
			case "failure":
				return new Lines([paint.ink("bad", `⊘ ${FAILURE_TITLE[item.type]}`), paint.ink("dim", item.message), ...(item.requestId === undefined ? [] : [paint.ink("dim", `request ${item.requestId}`)])]);
			case "compacted":
				return new Lines([paint.ink("dim", "── earlier messages summarized ──")]);
		}
	}
}

/** The foot: the open session's state, model, thinking and context, and the keys. */
class StatusLine implements Component {
	meta: SessionMeta | undefined;
	note: string | undefined;
	private readonly paint: Paint;
	constructor(paint: Paint) {
		this.paint = paint;
	}
	render(width: number): string[] {
		const { paint, meta } = this;
		const keys = paint.ink("dim", "↑↓ session  PgUp PgDn scroll  q quit");
		let left = "";
		if (this.note !== undefined) left = paint.ink("wait", this.note);
		else if (meta !== undefined) {
			const tokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
			const context = meta.context.window > 0 ? `${tokens(meta.context.used)} / ${tokens(meta.context.window)}` : tokens(meta.context.used);
			const retry = meta.retry === undefined ? "" : paint.ink("wait", ` · retrying: ${meta.retry.error}`);
			left = `${markOf(paint, meta.summary.state)} ${meta.summary.state} ${paint.ink("dim", "·")} ${meta.model.name} ${paint.ink("dim", "·")} ${meta.thinking} ${paint.ink("dim", "·")} ${context}${retry}`;
		}
		const room = width - visibleWidth(keys) - 2;
		if (room < 20) return [fit(left || keys, width)];
		const shown = fit(left, room);
		return [`${shown}${" ".repeat(Math.max(2, width - visibleWidth(shown) - visibleWidth(keys)))}${keys}`];
	}
	invalidate(): void {}
}

/** A live connection to the host: its events, and the session to follow. Calls `onClose` when the host goes away. */
function liveConnection(path: string, onEvent: (event: ServerEvent) => void, onFailure: (message: string) => void, onClose: () => void) {
	const socket: Socket = connect(path);
	socket.once("connect", () => socket.write(`${JSON.stringify({ type: "live" })}\n`));
	socket.once("error", () => {});
	socket.once("close", onClose);
	createInterface({ input: socket }).on("line", (text) => {
		const message = parseServerMessage(text);
		if (message.type === "event") onEvent(message.event);
		// A host from before the terminal UI answers `live` as a request it doesn't know.
		else if (message.type === "line") onFailure(message.text.replace(/^! /, ""));
	});
	return {
		follow: (session: number | null) => socket.writable && socket.write(`${JSON.stringify({ type: "follow", session })}\n`),
		close: () => socket.destroy(),
	};
}

/** Whether the host answers on its socket, and why not if it doesn't. */
function reachable(path: string): Promise<string | undefined> {
	return new Promise((resolve) => {
		const probe = connect(path);
		probe.once("connect", () => {
			probe.end();
			resolve(undefined);
		});
		probe.once("error", (error) => resolve(error.message));
	});
}

export type TuiOptions = {
	/** The session to open first; otherwise the one that most needs you. */
	session?: number;
	/** A terminal in place of this process's; tests pass one of a fixed size. */
	terminal?: Terminal;
	/** Hears what's on screen once the UI is running, for tests. */
	ready?: (ui: { screen: () => string[]; quit: () => void }) => void;
};

/** Runs the terminal UI until q or Ctrl+C. Resolves with the exit code. */
export async function runTui(config: Config, options: TuiOptions = {}): Promise<number> {
	const path = socketPathFor(config);
	const unreachable = await reachable(path);
	if (unreachable !== undefined) {
		console.error(`can't reach the aludra server (${unreachable}). Start it with: aludra serve`);
		return 1;
	}
	// In color unless NO_COLOR asks otherwise, at the depth pi-tui finds the terminal has.
	const paint = pen(process.env.NO_COLOR ? 1 : getTerminalColorMode() === "truecolor" ? 24 : 8);
	const tree = new SessionTree(paint);
	const header = new Header(paint);
	const transcript = new Transcript(paint);
	const status = new StatusLine(paint);
	const treeView = new ScrollView(tree, { follow: "none", overscroll: "contain", scrollbar: "hidden" });
	const transcriptView = new ScrollView(transcript, { follow: "end", primary: true, scrollbar: "auto" });

	const terminal = options.terminal ?? new ProcessTerminal();
	const tui = new TuiAltScreen(terminal, false, undefined, { mouse: true });
	const treeWidth = Math.max(28, Math.min(44, Math.floor(terminal.columns * 0.3)));
	tui.setLayoutRoot(new VStack([
		{
			component: new HStack([
				{ component: treeView, basis: treeWidth, shrink: 0, minSize: 20 },
				{ component: new VStack([{ component: header, basis: "auto" }, { component: transcriptView, basis: 0, grow: 1, minSize: 1 }]), basis: 0, grow: 1, minSize: 20 },
			], { gap: 2 }),
			basis: 0,
			grow: 1,
			minSize: 1,
		},
		{ component: status, basis: 1, shrink: 0 },
	]));

	let items: Item[] = [];
	let meta: SessionMeta | undefined;
	let followed: number | undefined;
	let link: ReturnType<typeof liveConnection> | undefined;
	let stopped = false;
	let failed: string | undefined;

	const showTranscript = () => {
		transcript.set(items, meta);
		header.summary = meta?.summary ?? tree.sessions.find((s) => s.id === followed);
		status.meta = meta;
		tui.requestRender();
	};

	function select(id: number | undefined) {
		if (id === tree.selected && id === followed) return;
		tree.selected = id;
		header.colors = tree.colors;
		if (id !== followed) {
			followed = id;
			items = [];
			meta = undefined;
			showTranscript();
			link?.follow(id ?? null);
			transcriptView.scrollToEnd();
		}
		// Keep the selected row in view.
		if (id !== undefined) {
			const row = tree.rowOf(id);
			const height = treeView.viewportHeight;
			if (height > 0 && (row < treeView.scrollTop || row >= treeView.scrollTop + height)) treeView.scrollTo(Math.max(0, row - Math.floor(height / 3)), { disableFollow: true });
		}
		tui.requestRender();
	}

	function onEvent(event: ServerEvent) {
		switch (event.type) {
			case "sessions": {
				const first = tree.sessions.length === 0;
				tree.sessions = event.sessions;
				if (first || (tree.selected !== undefined && !event.sessions.some((s) => s.id === tree.selected))) {
					const wanted = event.sessions.find((s) => s.id === options.session) ?? tree.order()[0];
					select(wanted?.id);
				}
				if (meta === undefined) header.summary = tree.sessions.find((s) => s.id === followed);
				tui.requestRender();
				return;
			}
			case "colors":
				tree.colors = event.colors;
				header.colors = event.colors;
				tui.requestRender();
				return;
			case "items":
				if (event.session !== followed) return;
				items = [...items.slice(0, event.start), ...event.items].slice(0, event.length);
				showTranscript();
				return;
			case "meta":
				if (event.session !== followed) return;
				meta = event.meta;
				showTranscript();
				return;
			case "error":
				status.note = event.message;
				tui.requestRender();
				return;
			case "ideas":
				return;
		}
	}

	function open() {
		link = liveConnection(
			path,
			(event) => {
				status.note = undefined;
				onEvent(event);
			},
			(message) => {
				failed = `The running host is older than this aludra and has no terminal UI (${message}). Update it: sh scripts/install.sh`;
				quit();
			},
			() => {
				if (stopped) return;
				// The host restarted, or is restarting: say so and try again.
				status.note = "Lost the host; reconnecting…";
				tui.requestRender();
				setTimeout(() => {
					if (stopped) return;
					open();
					if (followed !== undefined) link?.follow(followed);
				}, 1000);
			},
		);
		if (followed !== undefined) link.follow(followed);
	}

	let resolveDone: (code: number) => void = () => {};
	const done = new Promise<number>((resolve) => (resolveDone = resolve));
	function quit() {
		if (stopped) return;
		stopped = true;
		clearInterval(tick);
		process.off("SIGTERM", quit);
		link?.close();
		tui.stop({ preserveScreen: true });
		if (failed !== undefined) console.error(failed);
		resolveDone(failed === undefined ? 0 : 1);
	}

	tui.addInputListener((data) => {
		if (matchesKey(data, Key.ctrl("c")) || data === "q") {
			quit();
			return { consume: true };
		}
		const order = tree.order();
		const at = order.findIndex((s) => s.id === tree.selected);
		if (matchesKey(data, Key.up) || data === "k") {
			select(order[Math.max(0, at - 1)]?.id);
			return { consume: true };
		}
		if (matchesKey(data, Key.down) || data === "j") {
			select(order[Math.min(order.length - 1, at + 1)]?.id);
			return { consume: true };
		}
		if (matchesKey(data, Key.end) || data === "G") {
			transcriptView.scrollToEnd();
			tui.requestRender();
			return { consume: true };
		}
		if (matchesKey(data, Key.home) || data === "g") {
			transcriptView.scrollToStart();
			tui.requestRender();
			return { consume: true };
		}
		return undefined;
	});
	// Ages move on.
	const tick = setInterval(() => tui.requestRender(), 30_000);
	process.once("SIGTERM", quit);

	tui.start();
	open();
	options.ready?.({ screen: () => tui.getScreenLines(), quit });
	return done;
}
