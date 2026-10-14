// What's live, for the apps' sockets: every session's summary, ideas and picked colors, kept current, and the transcript
// and meta of the session a client follows. The web app gets it over /api/live (src/api.ts) and the terminal UI over the
// CLI's socket (src/server.ts, src/tui.ts); both speak ServerEvent and ClientEvent (src/api-types.ts).
import type { ConversationView } from "@earendil-works/pi-durable";
import type { Item, ServerEvent, SessionMeta, SessionSummary, Thinking } from "./api-types.ts";
import { context, type Host, type SessionRecord } from "./host.ts";
import { contextUsed, firstChange, itemsOf, lineOf, queuedOf, spendOf, stateOf, updatedAt } from "./transcript.ts";

/** One client's view: its list of sessions, ideas and colors, and the session it follows. */
export type LiveClient = {
	/** Follows session `id`'s transcript instead of the one before, or none with null. */
	follow(id: number | null): void;
	close(): void;
};

/** The sessions feed, shared by every client, and a way to connect one. */
export function createLive(host: Host) {
	const runEnd = new Set<(summary: SessionSummary) => void>();
	const feed = sessionsFeed(host, (summary) => runEnd.forEach((listener) => listener(summary)));
	feed.start();

	function connect(send: (event: ServerEvent) => void): LiveClient {
		const stopFeed = feed.subscribe((sessions) => send({ type: "sessions", sessions }));
		const sendIdeas = () => void host.ideas.list().then((ideas) => send({ type: "ideas", ideas }), (error) => console.error("[live]", error));
		const stopIdeas = host.ideas.onChange(sendIdeas);
		sendIdeas();
		const stopColors = host.colors.onChange((colors) => send({ type: "colors", colors }));
		void host.colors.list().then((colors) => send({ type: "colors", colors }), (error) => console.error("[live]", error));
		let following: Promise<(() => void) | undefined> = Promise.resolve(undefined);
		let closed = false;
		return {
			follow(id) {
				// One at a time: the last one asked for wins, and the ones before it stop once they've started.
				following = following.then((stop) => {
					stop?.();
					if (id === null || closed) return undefined;
					return follow(host, id, send, feed).catch((error) => {
						send({ type: "error", message: String(error?.message ?? error) });
						return undefined;
					});
				});
			},
			close() {
				closed = true;
				stopIdeas();
				stopColors();
				stopFeed();
				void following.then((stop) => stop?.());
			},
		};
	}

	return {
		connect,
		/** Calls `listener` with a session whose run just ended done or failed, once per run. */
		onRunEnd(listener: (summary: SessionSummary) => void): () => void {
			runEnd.add(listener);
			return () => runEnd.delete(listener);
		},
		/** Reads session `id` again. */
		touch: (id: number) => feed.touch(id),
		close: () => feed.close(),
	};
}

export type Live = ReturnType<typeof createLive>;

/** Sends `send` session `id`'s transcript and meta, then each change, until the returned function is called. */
async function follow(host: Host, id: number, send: (event: ServerEvent) => void, feed: SessionsFeed): Promise<() => void> {
	let record = await host.sessions.get(id);
	if (record === undefined) throw new Error(`No session ${id}`);
	const state = await (await host.conversation(id)).viewState(context);
	let sent: string[] = [];
	let sentMeta = "";
	let stopped = false;
	let pending: ConversationView | undefined;
	let timer: NodeJS.Timeout | undefined;

	async function publish(view: ConversationView) {
		const items = itemsOf(view);
		const keys = items.map((item) => JSON.stringify(item));
		const start = firstChange(sent, keys);
		if (start < keys.length || keys.length !== sent.length) send({ type: "items", session: id, start, items: items.slice(start), length: items.length });
		sent = keys;
		const meta = await metaOf(host, record!, view, items);
		if (stopped) return;
		const metaJson = JSON.stringify(meta);
		if (metaJson !== sentMeta) send({ type: "meta", session: id, meta });
		sentMeta = metaJson;
		feed.update(meta.summary);
	}
	// Commits come every 100 ms while an answer streams; send at most every 50 ms.
	const schedule = (view: ConversationView) => {
		pending = view;
		timer ??= setTimeout(() => {
			timer = undefined;
			const next = pending!;
			pending = undefined;
			if (!stopped) publish(next).catch((error) => console.error("[live]", error));
		}, 50);
	};
	await publish(state.value);
	const unsubscribe = state.subscribe((view) => schedule(view));
	const unwatchApprovals = host.approvals.onChange((request) => {
		if (request.conversationId === id) schedule(state.value);
	});
	// A new title: the meta, and the summary it gives the feed, must carry it, or the next publish would put back
	// the old one.
	const unwatchRecord = host.sessions.onUpdate((updated) => {
		if (updated.id !== id) return;
		record = updated;
		schedule(state.value);
	});
	return () => {
		stopped = true;
		clearTimeout(timer);
		unsubscribe();
		unwatchApprovals();
		unwatchRecord();
		state.dispose();
	};
}

async function metaOf(host: Host, record: SessionRecord, view: ConversationView, items: readonly Item[]): Promise<SessionMeta> {
	const approval = (await host.approvals.all()).find((r) => r.conversationId === record.id && r.status === "pending");
	// SAFETY: a document in the view is the JSON of its kind's state.
	const agent = view.docs["pi.agent"] as { model?: { provider: string; modelId: string }; thinkingLevel?: Thinking } | undefined;
	const ref = agent?.model ?? host.model;
	const info = host.modelInfo(ref);
	// SAFETY: as above.
	const retry = (view.docs["pi.live"] as { generation?: { retry?: { at: number; error: string } } } | undefined)?.generation?.retry;
	return {
		summary: summaryOf(record, view, items, approval !== undefined),
		model: { provider: ref.provider, id: ref.modelId, name: info.name },
		thinking: agent?.thinkingLevel ?? host.thinking,
		context: { used: contextUsed(view), window: info.window },
		queued: queuedOf(view),
		...(approval === undefined ? {} : { approval: { id: approval.id, summary: approval.summary, command: approval.command } }),
		...(retry === undefined ? {} : { retry }),
	};
}

function summaryOf(record: SessionRecord, view: ConversationView, items: readonly Item[], waiting: boolean): SessionSummary {
	const state = stateOf(view, waiting);
	const { id, workspace, project, dir, title, createdAt } = record;
	const cost = spendOf(view);
	return { id, workspace, project, dir, title, createdAt, updatedAt: updatedAt(view, record.createdAt), state, line: lineOf(items, state), ...(cost === undefined ? {} : { cost }) };
}

/** Session `id`'s summary as the drawer shows it, read from its view; undefined if there's no such session. */
export async function readSummary(host: Host, id: number): Promise<SessionSummary | undefined> {
	const record = await host.sessions.get(id);
	if (record === undefined) return undefined;
	const state = await (await host.conversation(id)).viewState(context);
	try {
		const waiting = (await host.approvals.all()).some((r) => r.conversationId === id && r.status === "pending");
		return summaryOf(record, state.value, itemsOf(state.value), waiting);
	} finally {
		state.dispose();
	}
}

/** Dollars session `id` spent on billed providers from `since` on; undefined if it never used one. */
export async function readSpend(host: Host, id: number, since: number): Promise<number | undefined> {
	const state = await (await host.conversation(id)).viewState(context);
	try {
		return spendOf(state.value, since);
	} finally {
		state.dispose();
	}
}

type SessionsFeed = ReturnType<typeof sessionsFeed>;

/**
 * Every session's summary, kept current: a session is read again when a task of it starts or ends, when one of its
 * approvals changes, and when it's created. A session someone follows is updated from its view as it changes.
 */
function sessionsFeed(host: Host, onRunEnd: (summary: SessionSummary) => void) {
	const summaries = new Map<number, SessionSummary>();
	const put = (summary: SessionSummary) => {
		const before = summaries.get(summary.id);
		summaries.set(summary.id, summary);
		return before;
	};
	/** Sessions whose run's tasks just ended; read again, a run that ended done or failed is reported once. */
	const ended = new Set<number>();
	/** The last run reported per session, by its newest timestamp, so a run is reported once. */
	const reported = new Map<number, number>();
	const listeners = new Set<(sessions: SessionSummary[]) => void>();
	let live = new Set<number>();
	let ready: Promise<void> | undefined;
	let graphStop: (() => Promise<unknown>) | undefined;
	let timer: NodeJS.Timeout | undefined;
	const dirty = new Set<number>();
	const unsubscribe: (() => unknown)[] = [];
	let closed = false;

	const list = () => [...summaries.values()].sort((a, b) => b.updatedAt - a.updatedAt);
	const broadcast = () => {
		const sessions = list();
		for (const listener of listeners) listener(sessions);
	};

	const read = (id: number) => readSummary(host, id);

	async function flush() {
		timer = undefined;
		const ids = [...dirty];
		dirty.clear();
		for (const id of ids) {
			const summary = await read(id);
			if (summary === undefined) continue;
			put(summary);
			if (!ended.delete(id) || (summary.state !== "done" && summary.state !== "failed")) continue;
			if (reported.get(id) === summary.updatedAt) continue;
			reported.set(id, summary.updatedAt);
			onRunEnd(summary);
		}
		if (!closed && ids.length > 0) broadcast();
	}

	function mark(ids: Iterable<number>) {
		for (const id of ids) dirty.add(id);
		timer ??= setTimeout(() => void flush().catch((error) => console.error("[live]", error)), 150);
	}

	async function start() {
		for (const record of await host.sessions.list()) {
			const summary = await read(record.id);
			if (summary !== undefined) summaries.set(record.id, summary);
		}
		const graph = await host.harness.watchTaskGraph(context);
		graphStop = () => graph.stop();
		// A session works while it has a generation or tool task; a background compaction isn't a run.
		const working = (value: typeof graph.value) =>
			new Set(Object.values(value.tasks).filter((task) => task.kind === "pi.generation" || task.kind === "pi.tool").map((task) => Number(task.conversationId)));
		const onGraph = (value: typeof graph.value) => {
			const now = working(value);
			for (const id of live) if (!now.has(id)) ended.add(id);
			// Sessions working now, and those that just stopped.
			mark(new Set([...now, ...live, ...Object.values(value.tasks).map((task) => Number(task.conversationId))]));
			live = now;
		};
		live = working(graph.value);
		graph.start(async (value) => onGraph(value));
		unsubscribe.push(
			host.approvals.onChange((request) => mark([request.conversationId])),
			host.sessions.onCreate((record) => mark([record.id])),
			host.sessions.onUpdate((record) => mark([record.id])),
		);
	}

	return {
		/** Starts watching the sessions, for notifications, before anyone subscribes. */
		start() {
			ready ??= start();
			ready.catch((error) => console.error("[live]", error));
		},
		/** Calls `listener` with every session now and after each change. */
		subscribe(listener: (sessions: SessionSummary[]) => void): () => void {
			listeners.add(listener);
			ready ??= start();
			ready.then(() => listeners.has(listener) && listener(list()), (error) => console.error("[live]", error));
			return () => listeners.delete(listener);
		},
		/** A followed session's new summary, from its view. */
		update(summary: SessionSummary) {
			const before = put(summary);
			if (JSON.stringify(before) !== JSON.stringify(summary)) broadcast();
		},
		/** Reads session `id` again. */
		touch(id: number) {
			mark([id]);
		},
		close() {
			closed = true;
			clearTimeout(timer);
			for (const stop of unsubscribe) stop();
			void graphStop?.();
		},
	};
}
