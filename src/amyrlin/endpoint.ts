// The amyrlin Mac app's way in: protocol v1 (amyrlin's docs/protocol.md) over one WebSocket at /amyrlin, next to the
// web app's /api/live. Same host, same sessions, so a session started on the phone continues on the Mac and back.
//
// What maps onto what:
// - A conversation is an aludra session; its project is fixed when it's made (`conversations.create` takes a project
//   directory, or a `cwd` naming one), so `configure` changes only the model and thinking.
// - Approvals are aludra's (src/permissions.ts): pending requests become `approval.requested`, and a decision, expiry,
//   stop or new message becomes `approval.resolved` (approve, deny, or cancelled). `approval.answer` with `always`
//   allows the request's summary for the rest of the session; summaries list those as `alwaysAllowed`, and
//   `approval.forget` takes one back.
// - Spend is pi-durable's usage. On the subscription its cost is 0; token counts are real.
// - Forks aren't an aludra feature; that method answers `unsupported`. Archiving hides a session from the lists, as
//   aludra's own apps do; host.watch carries archived sessions and the client filters.
import { randomUUID } from "node:crypto";
import { AgentDoc, defineDoc, UsageDoc, watchEvents } from "@earendil-works/pi-durable";
import type { WebSocket } from "ws";
import { THINKING, type Thinking } from "../config.ts";
import { context, conversationId, type Host, type SessionRecord } from "../host.ts";
import { type ImageInput, messageContent, titleOf } from "../images.ts";
import type { ApprovalRequest } from "../permissions.ts";
import { monthSpend } from "../live.ts";
import { billedCost } from "../transcript.ts";
import { DurableTranslator, entryItem, type Json, text, usageState } from "./translate.ts";

const LIMITS = { maxFrameBytes: 16 * 1024 * 1024, snapshotItems: 200 };
/** Above this much unsent data, a subscription waits, and pi-durable replaces what it falls behind on with a snapshot. */
const BACKPRESSURE_BYTES = 8 * 1024 * 1024;

/** The host's identity for the app, and `conversations.create` request IDs already handled. */
const AmyrlinDoc = defineDoc<{ hostId?: string; created: Record<string, number> }>({
	kind: "aludra.amyrlin",
	version: 1,
	scope: "session",
	initial: () => ({ created: {} }),
});

export class ProtocolError extends Error {
	readonly code: string;
	readonly data: Json;
	constructor(code: string, message: string, data?: Json) {
		super(message);
		this.code = code;
		this.data = data;
	}
}

const DECISIONS: Record<ApprovalRequest["status"], string | undefined> = {
	pending: undefined,
	approved: "approve",
	denied: "deny",
	expired: "cancelled",
	cancelled: "cancelled",
	superseded: "cancelled",
};

export function createAmyrlinEndpoint(host: Host, options: { name: string }) {
	const { harness, approvals } = host;
	let hostId: string | undefined;
	const summaries = new Map<number, Json>();
	const summaryListeners = new Set<(summary: Json) => void>();
	const approvalListeners = new Set<(conversation: number, event: Json) => void>();
	const callIds = new Map<string, string>();
	const dirty = new Set<number>();
	let flushTimer: ReturnType<typeof setTimeout> | undefined;

	async function identity() {
		hostId ??= await host.root.commit(async (tx) => {
			const doc = await tx.doc(AmyrlinDoc);
			doc.hostId ??= randomUUID();
			return doc.hostId;
		}, context);
		return { hostId, name: options.name, serverVersion: "aludra", durableVersion: "1.3.0" };
	}

	// Approvals (protocol section 8)

	/** The tool call a request waits on: its task's input names it. */
	async function callIdOf(request: ApprovalRequest): Promise<string> {
		const known = callIds.get(request.id);
		if (known !== undefined) return known;
		// SAFETY: the task id is one Pi Durable gave out, stored as it was.
		const task = await harness.getTask(request.taskId as Parameters<typeof harness.getTask>[0], context);
		const callId = (task?.input as { callId?: string } | undefined)?.callId ?? request.id;
		callIds.set(request.id, callId);
		return callId;
	}

	async function wireApproval(request: ApprovalRequest): Promise<Json> {
		return {
			approvalId: request.id,
			conversationId: request.conversationId,
			callId: await callIdOf(request),
			toolName: "bash",
			args: { command: request.command },
			requestedAt: request.createdAt,
			summary: request.summary,
		};
	}

	const stopApprovals = approvals.onChange((request) => {
		markDirty(request.conversationId);
		void (async () => {
			const decision = DECISIONS[request.status];
			const event = decision === undefined
				? { type: "approval.requested", approval: await wireApproval(request) }
				: { type: "approval.resolved", approvalId: request.id, decision };
			for (const listener of approvalListeners) listener(request.conversationId, event);
		})();
	});

	async function pendingApprovals(id: number): Promise<Json[]> {
		const pending = (await approvals.pending()).filter((r) => r.conversationId === id);
		return Promise.all(pending.map(wireApproval));
	}

	// Summaries (protocol sections 4.10 and 6.2)

	async function summaryOf(record: SessionRecord, state: "running" | "waiting" | "idle"): Promise<Json> {
		const id = conversationId(record.id);
		const [agent, usage, conversation, allowed] = await Promise.all([
			harness.snapshot(AgentDoc, id, context),
			harness.snapshot(UsageDoc, id, context),
			harness.conversation(id, context),
			approvals.allowed(record.id),
		]);
		const newest = conversation === undefined ? undefined : (await conversation.entries({}, 1, undefined, context)).items[0];
		const pending = state === "waiting" ? (await approvals.pending()).filter((r) => r.conversationId === record.id).length : 0;
		return {
			id: record.id,
			title: record.title,
			status: state === "waiting" ? "needsApproval" : state === "running" ? "busy" : "idle",
			archived: record.archived === true,
			parent: null,
			model: agent?.model ?? host.model,
			createdAt: record.createdAt,
			updatedAt: newest?.model?.[0]?.timestamp ?? record.createdAt,
			pendingApprovals: pending,
			spend: usageState(usage),
			// What was charged: `spend` prices every answer at API rates, plan-paid ones too.
			...costOf(billedCost(usage)),
			workspace: record.workspace,
			// A no-project session has no `project`; its `dir` is its scratch directory.
			...(record.scratch === true ? {} : { project: record.project }),
			dir: record.dir,
			...(allowed.length > 0 ? { alwaysAllowed: allowed } : {}),
		};
	}

	async function refreshAll(): Promise<void> {
		const states = await host.sessions.states();
		for (const record of await host.sessions.list()) summaries.set(record.id, await summaryOf(record, states.get(record.id) ?? "idle"));
	}

	function markDirty(id: number) {
		dirty.add(id);
		flushTimer ??= setTimeout(() => void flush().catch((error) => console.error("[amyrlin] summaries", error)), 250);
	}

	/** At most four summary updates a second (section 6.2). */
	async function flush() {
		flushTimer = undefined;
		const ids = [...dirty];
		dirty.clear();
		const states = await host.sessions.states();
		for (const id of ids) {
			const record = await host.sessions.get(id);
			if (record === undefined) continue;
			publishSummary(await summaryOf(record, states.get(id) ?? "idle"));
		}
	}

	/** Keeps `summary` for the list, and tells every watcher if it changed. */
	function publishSummary(summary: Json) {
		if (JSON.stringify(summary) === JSON.stringify(summaries.get(summary.id))) return;
		summaries.set(summary.id, summary);
		for (const listener of summaryListeners) listener(summary);
	}

	const stopCommits = harness.subscribeCommits((publication) => {
		for (const change of publication.changes) {
			const id = change.type === "document" || change.type === "document.copy" ? change.conversationId
				: change.type === "conversation" ? change.value.id
				: change.type === "entry" || change.type === "submission" ? change.value.conversationId
				: change.type === "task" ? change.value.conversationId
				: undefined;
			if (id !== undefined && summaries.has(Number(id))) markDirty(Number(id));
		}
	});
	const stopCreated = host.sessions.onCreate((record) => markDirty(record.id));
	const stopUpdated = host.sessions.onUpdate((record) => markDirty(record.id));
	const ready = refreshAll();

	const listSummaries = () => [...summaries.values()].sort((a, b) => b.updatedAt - a.updatedAt);

	/** A summary's `cost`: dollars charged by providers that bill each request, present only when it used one. */
	const costOf = (cost: number | undefined): Json => (cost === undefined ? {} : { cost });

	/** The host's `monthCost`: this calendar month's charged dollars, present only when any session was charged. */
	async function monthCostOf(): Promise<Json> {
		await ready;
		const billed = listSummaries().filter((c) => c.cost !== undefined).map((c) => Number(c.id));
		return billed.length === 0 ? {} : { monthCost: await monthSpend(host, billed) };
	}

	async function hostSpend(): Promise<Json> {
		return usageState(await harness.usage(context));
	}

	// Sessions

	async function session(id: unknown) {
		if (typeof id !== "number") throw new ProtocolError("bad_request", "conversationId should be a number");
		const record = await host.sessions.get(id);
		if (record === undefined) throw new ProtocolError("not_found", `No session ${id}`);
		return { record, conversation: await host.conversation(id) };
	}

	async function settingsOf(id: number): Promise<Json> {
		const cid = conversationId(id);
		const stored = (await harness.snapshot(AgentDoc, cid, context)) ?? {};
		const conversation = await harness.conversation(cid, context);
		const agent = conversation === undefined ? undefined : await conversation.agent(context);
		const out: Json = {};
		for (const key of ["model", "thinkingLevel", "cwd", "tools", "instructions"] as const) {
			if (stored[key] !== undefined) out[key] = stored[key];
		}
		return {
			stored: out,
			effective: {
				model: agent?.model ?? host.model,
				thinkingLevel: agent?.thinkingLevel ?? host.thinking,
				cwd: agent?.cwd ?? null,
				tools: agent?.tools.map((tool) => tool.name) ?? [],
			},
		};
	}

	function thinkingOf(value: unknown): Thinking {
		if (typeof value !== "string" || !(THINKING as readonly string[]).includes(value)) {
			throw new ProtocolError("invalid_settings", `Thinking level ${String(value)} isn't one of ${THINKING.join(", ")}`);
		}
		// SAFETY: checked against THINKING just above.
		return value as Thinking;
	}

	/** A model the Mac named, as host.choose takes it: any model a provider has, pinned or not. */
	function modelOf(value: Json): string {
		const id = value?.modelId;
		if (typeof id !== "string" || typeof value.provider !== "string" || !host.hasModel(value.provider, id)) {
			throw new ProtocolError("invalid_settings", `${value?.provider}/${id} isn't one of the models aludra offers`);
		}
		return `${value.provider}/${id}`;
	}

	async function create(p: Json): Promise<Json> {
		if (typeof p.requestId !== "string") throw new ProtocolError("bad_request", "requestId is required");
		const doc = await harness.snapshot(AmyrlinDoc, context);
		const existing = doc?.created[p.requestId];
		if (existing !== undefined) {
			const record = await host.sessions.get(existing);
			if (record !== undefined) return { conversation: summaries.get(existing) ?? (await summaryOf(record, "idle")), duplicate: true };
		}
		// No project (and no cwd naming one) makes a no-project session, in a scratch directory of its own.
		const dir = typeof p.project === "string" ? p.project : p.settings?.cwd;
		const project = dir == null ? undefined : host.projects().find((candidate) => candidate.dir === dir);
		if (dir != null && project === undefined) throw new ProtocolError("invalid_settings", `${String(dir)} isn't a project aludra knows; host.info lists them`);
		const images = imagesParam(p.images);
		const text = typeof p.text === "string" ? p.text : "";
		const first = text.trim() !== "" || images.length > 0 ? content(text, images) : undefined;
		const agent: { model?: string; thinking?: Thinking } = {};
		if (p.settings?.model != null) agent.model = modelOf(p.settings.model);
		if (p.settings?.thinkingLevel != null) agent.thinking = thinkingOf(p.settings.thinkingLevel);
		const title = first !== undefined ? titleOf(text, images) : typeof p.title === "string" && p.title.trim() !== "" ? p.title : "New session";
		const record = project === undefined ? await host.sessions.createScratch(title, agent) : await host.sessions.create(project, title, agent);
		await host.root.commit(async (tx) => {
			(await tx.doc(AmyrlinDoc)).created[p.requestId] = record.id;
		}, context);
		if (first !== undefined) await host.submit(record.id, first, { requestId: `${p.requestId}:first` });
		const summary = await summaryOf(record, first === undefined ? "idle" : "running");
		summaries.set(record.id, summary);
		return { conversation: summary, duplicate: false };
	}

	async function submit(p: Json): Promise<Json> {
		if (typeof p.requestId !== "string" || typeof p.text !== "string") throw new ProtocolError("bad_request", "submit needs requestId and text");
		const message = content(p.text, imagesParam(p.images));
		const whenBusy = p.whenBusy ?? "followUp";
		if (!["followUp", "steer", "reject"].includes(whenBusy)) throw new ProtocolError("bad_request", `whenBusy ${whenBusy}`);
		const { record } = await session(p.conversationId);
		const before = await harness.commit((tx) => tx.submissionByRequest(conversationId(record.id), p.requestId), context);
		if (whenBusy === "reject" && before === undefined && (await host.sessions.states()).get(record.id) !== "idle") {
			throw new ProtocolError("busy", "The session is busy");
		}
		const submission = await host.submit(record.id, message, { requestId: p.requestId, steer: whenBusy === "steer" });
		const status = await submission.status(context);
		const wire: Json = { id: status.id, type: status.type, status: status.status };
		if (status.requestId !== undefined) wire.requestId = status.requestId;
		if (status.entry !== undefined) wire.entryId = status.entry;
		if (status.answer !== undefined) wire.answerId = status.answer;
		if (status.reason !== undefined) wire.reason = status.reason;
		return { submission: wire, duplicate: before !== undefined };
	}

	async function configure(p: Json): Promise<Json> {
		const { record } = await session(p.conversationId);
		const changes = p.changes ?? {};
		for (const key of ["cwd", "tools"]) {
			if (key in changes) throw new ProtocolError("invalid_settings", `A session's ${key} is fixed by its project`);
		}
		const change: { model?: string; thinking?: Thinking } = {};
		if ("model" in changes) {
			if (changes.model === null) throw new ProtocolError("invalid_settings", "A session needs a model; choose one instead");
			change.model = modelOf(changes.model);
		}
		if ("thinkingLevel" in changes) {
			if (changes.thinkingLevel === null) throw new ProtocolError("invalid_settings", "Choose a thinking level instead of clearing it");
			change.thinking = thinkingOf(changes.thinkingLevel);
		}
		await host.configure(record.id, change);
		return { settings: await settingsOf(record.id) };
	}

	async function answer(p: Json): Promise<Json> {
		if (!["approve", "deny"].includes(p.decision)) throw new ProtocolError("bad_request", `decision ${p.decision}`);
		const always = p.always === true;
		if (always && p.decision !== "approve") throw new ProtocolError("bad_request", "Only an approve can be always");
		const id = String(p.approvalId);
		const decided = await approvals.decide(id, p.decision === "approve", always);
		const request = decided ?? (await approvals.all()).find((r) => r.id === id);
		if (request === undefined) throw new ProtocolError("not_found", `No approval ${id}`);
		const decision = DECISIONS[request.status];
		const resolution = { ...(await wireApproval(request)), decision };
		if (decided === undefined && decision !== p.decision) {
			throw new ProtocolError("already_resolved", `Approval ${id} was already ${request.status}`, resolution);
		}
		// A retried answer that the first one already approved still leaves the summary allowed.
		if (decided === undefined && always) {
			await approvals.allow(request.conversationId, request.summary);
			markDirty(request.conversationId);
		}
		return { approval: resolution };
	}

	/** Items before `before`, oldest first. */
	async function itemsBefore(conversation: Awaited<ReturnType<typeof host.conversation>>, before: number, limit: number) {
		const items: Json[] = [];
		let cursor: Parameters<typeof conversation.entries>[2];
		let more = false;
		do {
			// SAFETY: an entry id bound from the client, only compared against stored ids.
			const page = await conversation.entries({ maxEntryId: (before - 1) as Parameters<typeof conversation.entries>[0]["maxEntryId"], order: "descending" }, limit, cursor, context);
			for (const entry of page.items) {
				const item = entryItem(entry);
				if (item === undefined) continue;
				if (items.length < limit) items.push(item);
				else more = true;
			}
			cursor = page.next;
		} while (cursor !== undefined && items.length < limit);
		return { items: items.reverse(), hasEarlier: more || cursor !== undefined };
	}

	/** A message's images from the app, `[{mimeType, data}]`. */
	function imagesParam(value: Json): ImageInput[] {
		if (value == null) return [];
		if (!Array.isArray(value) || !value.every((i: Json) => typeof i?.mimeType === "string" && typeof i?.data === "string")) {
			throw new ProtocolError("bad_request", "images should be a list of {mimeType, data}");
		}
		return value.map((i: Json) => ({ mimeType: i.mimeType, data: i.data }));
	}

	/** A message's content, or bad_request saying what's wrong with it. */
	function content(text: string, images: ImageInput[]) {
		try {
			return messageContent(text, images);
		} catch (error) {
			throw new ProtocolError("bad_request", error instanceof Error ? error.message : String(error));
		}
	}

	/** An image in a conversation's transcript: block `index` of entry `entryId`'s message (section 4.3 items). */
	async function image(p: Json): Promise<Json> {
		const { record } = await session(p.conversationId);
		if (typeof p.entryId !== "number" || typeof p.index !== "number") throw new ProtocolError("bad_request", "conversation.image takes conversationId, entryId and index");
		const found = await host.image(record.id, p.entryId, 0, p.index);
		if (found === undefined) throw new ProtocolError("not_found", `No image at entry ${p.entryId}, block ${p.index}`);
		return found;
	}

	async function history(p: Json): Promise<Json> {
		const { conversation } = await session(p.conversationId);
		const before = typeof p.before === "number" ? p.before : Number.MAX_SAFE_INTEGER;
		return itemsBefore(conversation, before, Math.min(Math.max(1, Number(p.limit ?? 100)), 500));
	}

	async function hostInfo(): Promise<Json> {
		const tools = [
			{ name: "read", description: "Read a file", requiresApproval: false },
			{ name: "write", description: "Write a file", requiresApproval: false },
			{ name: "edit", description: "Edit a file", requiresApproval: false },
			{ name: "bash", description: "Run a shell command. git push, and ssh, scp or rsync to the hosts listed in the settings, wait for approval.", requiresApproval: false },
		];
		return {
			host: await identity(),
			models: host.choices().map((choice) => {
				const info = host.modelInfo({ provider: choice.provider, modelId: choice.id });
				return { provider: choice.provider, modelId: choice.id, name: choice.name, reasoning: true, thinkingLevels: [...THINKING], contextWindow: info.window, available: true };
			}),
			tools,
			defaults: { model: host.model, thinkingLevel: host.thinking },
			projects: host.projects().map((p) => ({ workspace: p.workspace, name: p.name, path: p.path, dir: p.dir })),
			projectColors: await host.colors.list(),
			...(await monthCostOf()),
		};
	}

	// Watching one session (sections 6.1 and 7)

	async function watchConversation(id: number, send: (events: Json[]) => Promise<void>): Promise<() => Promise<void>> {
		const { record, conversation } = await session(id);
		let settings = await settingsOf(id);
		let inbox = new Map<number, { text?: string; kind?: string }>();
		let pending = await pendingApprovals(id);
		const readInbox = async () => {
			const view = (await conversation.viewState(context));
			const items = (view.value.docs["pi.inbox"] as { items?: Json[] } | undefined)?.items ?? [];
			view.dispose();
			inbox = new Map(items.map((item) => [Number(item.id), item.mode === "write" ? { kind: item.entry?.kind } : { text: text(item.content) }]));
		};
		await readInbox();
		const translator = new DurableTranslator({
			conversationId: id,
			conversation: () => ({ id, title: summaries.get(id)?.title ?? record.title, archived: summaries.get(id)?.archived ?? record.archived === true, parent: null, ...(record.scratch === true ? {} : { project: record.project }), dir: record.dir }),
			inboxExtra: (submission) => inbox.get(submission),
			settings: (agent) => ({ ...settings, stored: Object.fromEntries(["model", "thinkingLevel", "cwd", "tools", "instructions"].filter((k) => agent?.[k] !== undefined).map((k) => [k, agent[k]])) }),
			approvals: () => pending,
		});

		const completeSnapshot = async (snapshot: Json) => {
			if (snapshot.items.length > LIMITS.snapshotItems) {
				snapshot.items = snapshot.items.slice(-LIMITS.snapshotItems);
				snapshot.hasEarlier = true;
				return;
			}
			const lowest = Math.min(...snapshot.items.map((item: Json) => item.id));
			const before = Number.isFinite(lowest) ? lowest : Number.MAX_SAFE_INTEGER;
			const page = await itemsBefore(conversation, before, LIMITS.snapshotItems - snapshot.items.length);
			snapshot.items = [...page.items, ...snapshot.items];
			snapshot.hasEarlier = page.hasEarlier;
		};

		const translate = async (events: Json[]): Promise<Json[]> => {
			const types = new Set(events.map((e) => e.type));
			if (types.has("snapshot") || types.has("inbox_update")) await readInbox();
			if (types.has("snapshot") || types.has("agent_changed")) settings = await settingsOf(id);
			if (types.has("snapshot")) pending = await pendingApprovals(id);
			const out = translator.frames({ batch: events })[0] ?? [];
			for (const event of out) if (event.type === "snapshot") await completeSnapshot(event);
			return out;
		};

		const stream = await watchEvents(harness, conversationId(id), context);
		let stopped = false;
		await send(await translate([stream.snapshot]));
		const onApproval = (conversation: number, event: Json) => {
			if (conversation !== id || stopped) return;
			void send([event]);
			// Later snapshots of this watch carry the approvals pending now.
			void pendingApprovals(id).then((list) => void (pending = list));
		};
		approvalListeners.add(onApproval);
		stream.start(async (events) => {
			if (stopped) return;
			const out = await translate(events as Json[]);
			if (out.length > 0) await send(out);
		});
		return async () => {
			stopped = true;
			approvalListeners.delete(onApproval);
			await stream.stop();
		};
	}

	// One connection (sections 2 and 3)

	function connect(ws: WebSocket, you: { login: string; name: string }) {
		let welcomed = false;
		let nextSubscription = 1;
		const subscriptions = new Map<string, () => Promise<void>>();
		const sendFrame = (frame: Json) => {
			if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
		};
		/** Waits while the socket has too much unsent data, so a slow client slows its subscriptions. */
		const drained = () => new Promise<void>((resolve) => {
			const check = () => (ws.readyState !== ws.OPEN || ws.bufferedAmount < BACKPRESSURE_BYTES ? resolve() : setTimeout(check, 50));
			check();
		});
		const subscriber = (id: string) => {
			let seq = 0;
			return async (events: Json[]) => {
				if (!subscriptions.has(id)) return;
				sendFrame({ type: "event", subscription: id, seq: seq++, events });
				await drained();
			};
		};
		const ping = setInterval(() => {
			if (ws.readyState === ws.OPEN) ws.ping();
		}, 15_000);

		ws.on("message", (data) => void onMessage(String(data)));
		ws.on("close", () => {
			clearInterval(ping);
			for (const stop of subscriptions.values()) void stop().catch(() => {});
			subscriptions.clear();
		});

		async function onMessage(raw: string) {
			let frame: Json;
			try {
				frame = JSON.parse(raw);
			} catch {
				return ws.close(4400, "malformed frame");
			}
			if (!welcomed) {
				if (frame?.type !== "hello") return ws.close(4400, "expected hello");
				if (!Array.isArray(frame.protocols) || !frame.protocols.includes(1)) {
					sendFrame({ type: "goodbye", reason: "unsupported_protocol", protocols: [1] });
					return ws.close(4406, "unsupported protocol");
				}
				welcomed = true;
				return sendFrame({ type: "welcome", protocol: 1, host: await identity(), you, limits: LIMITS });
			}
			if (frame?.type !== "request" || typeof frame.id !== "string") return;
			const respond = (result: Json) => sendFrame({ type: "response", id: frame.id, result });
			const p = frame.params ?? {};
			try {
				switch (frame.method) {
					case "conversation.watch": {
						await session(p.conversationId);
						const id = `s${nextSubscription++}`;
						subscriptions.set(id, async () => {});
						respond({ subscription: id });
						try {
							const stop = await watchConversation(p.conversationId, subscriber(id));
							if (subscriptions.has(id)) subscriptions.set(id, stop);
							else await stop();
						} catch (error) {
							subscriptions.delete(id);
							sendFrame({ type: "end", subscription: id, reason: "internal" });
							console.error("[amyrlin] watch", error);
						}
						return;
					}
					case "host.watch": {
						await ready;
						const id = `s${nextSubscription++}`;
						const send = subscriber(id);
						const onSummary = (conversation: Json) => void send([{ type: "conversation.updated", conversation }]);
						let stopColors = () => {};
						subscriptions.set(id, async () => {
							summaryListeners.delete(onSummary);
							stopColors();
						});
						respond({ subscription: id });
						await send([{ type: "host.snapshot", host: await identity(), spend: await hostSpend(), ...(await monthCostOf()), conversations: listSummaries(), projectColors: await host.colors.list() }]);
						summaryListeners.add(onSummary);
						if (subscriptions.has(id)) stopColors = host.colors.onChange((projectColors) => void send([{ type: "host.projectColors", projectColors }]));
						return;
					}
					case "unsubscribe": {
						const stop = subscriptions.get(p.subscription);
						subscriptions.delete(p.subscription);
						await stop?.();
						return respond({});
					}
					default:
						return respond(await handle(frame.method, p));
				}
			} catch (error) {
				const known = error instanceof ProtocolError;
				const missing = !known && String((error as Error)?.message).startsWith("no session");
				if (!known && !missing) console.error(`[amyrlin] ${frame.method}`, error);
				const payload: Json = {
					code: known ? error.code : missing ? "not_found" : "internal",
					message: error instanceof Error ? error.message : String(error),
					retryable: false,
				};
				if (known && error.data !== undefined) payload.data = error.data;
				sendFrame({ type: "response", id: frame.id, error: payload });
			}
		}

		async function handle(method: string, p: Json): Promise<Json> {
			switch (method) {
				case "host.info":
					return hostInfo();
				case "conversations.list":
					await ready;
					return { conversations: p?.includeArchived === true ? listSummaries() : listSummaries().filter((c) => c.archived !== true) };
				case "conversations.create":
					return create(p);
				case "conversations.rename": {
					const { record } = await session(p.conversationId);
					if (typeof p.title !== "string") throw new ProtocolError("bad_request", "conversations.rename takes a title");
					let renamed;
					try {
						renamed = await host.sessions.rename(record.id, p.title);
					} catch (error) {
						throw new ProtocolError("bad_request", error instanceof Error ? error.message : String(error));
					}
					// The list and watchers have it at once, rather than at the next flush.
					const summary = await summaryOf(renamed, (await host.sessions.states()).get(renamed.id) ?? "idle");
					publishSummary(summary);
					return { conversation: summary };
				}
				case "conversations.archive": {
					const { record } = await session(p.conversationId);
					if (typeof p.archived !== "boolean") throw new ProtocolError("bad_request", "conversations.archive takes archived: true or false");
					const archived = await host.sessions.archive(record.id, p.archived);
					const summary = await summaryOf(archived, (await host.sessions.states()).get(archived.id) ?? "idle");
					// The list and watchers have it at once, rather than at the next flush.
					publishSummary(summary);
					return { conversation: summary };
				}
				case "conversations.fork":
					throw new ProtocolError("unsupported", `aludra doesn't support ${method}`);
				case "submit":
					return submit(p);
				case "abort":
					await host.stop((await session(p.conversationId)).record.id);
					return {};
				case "configure":
					return configure(p);
				case "compact":
					return { taskId: await (await session(p.conversationId)).conversation.compact(p.instructions ?? undefined, context) };
				case "reset":
					await (await session(p.conversationId)).conversation.reset(p.handoff ?? undefined, context);
					return {};
				case "approval.answer":
					return answer(p);
				case "approval.forget": {
					const { record } = await session(p.conversationId);
					if (typeof p.summary !== "string") throw new ProtocolError("bad_request", "approval.forget takes a summary");
					await approvals.forget(record.id, p.summary);
					// The list and watchers have it at once, rather than at the next flush.
					const summary = await summaryOf(record, (await host.sessions.states()).get(record.id) ?? "idle");
					publishSummary(summary);
					return { conversation: summary };
				}
				case "projects.setColor": {
					if (typeof p.project !== "string" || !(p.color === null || typeof p.color === "number")) throw new ProtocolError("bad_request", "projects.setColor takes a project name and a color, or null");
					try {
						return { projectColors: await host.colors.set(p.project, p.color) };
					} catch (error) {
						throw new ProtocolError("bad_request", error instanceof Error ? error.message : String(error));
					}
				}
				case "conversation.history":
					return history(p);
				case "conversation.image":
					return image(p);
				default:
					throw new ProtocolError("unknown_method", `Unknown method ${method}`);
			}
		}
	}

	return {
		connect,
		close() {
			clearTimeout(flushTimer);
			stopApprovals();
			stopCommits();
			stopCreated();
			stopUpdated();
		},
	};
}
