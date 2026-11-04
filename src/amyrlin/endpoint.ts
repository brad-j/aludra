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
// - `settings.get` and `settings.set` are aludra's own, not in protocol v1: the host's settings, each described for a
//   form (src/settings.ts). A host without them answers `unknown_method`.
// - Sandbox tasks (amyrlin's protocol section 10 item 19) are aludra's own too: `conversations.create` with `sandbox`,
//   the summary's `sandbox` and `source`, `sandbox.sync`, `sandbox.ship` with its `sandbox.shipped` event on host.watch,
//   and `sandbox.discard`, over src/sandboxes.ts, src/ship.ts and src/sandbox-cleanup.ts.
import { randomUUID } from "node:crypto";
import { AgentDoc, defineDoc, UsageDoc, watchEvents } from "@earendil-works/pi-durable";
import type { WebSocket } from "ws";
import { THINKING, type Thinking } from "../config.ts";
import { context, conversationId, type Host, isSandboxSession, SandboxNotReady, sandboxBranch, type SessionRecord } from "../host.ts";
import { ShipRefused, type ShipResult } from "../ship.ts";
import { checkImages, type ImageInput, messageContent, titleOf } from "../images.ts";
import { PAGE_CSP } from "../pages.ts";
import { checkFiles, type FileInput, MAX_FILE_BYTES, MAX_FILES, PASTE_BYTES } from "../files.ts";
import { checkVideos, MAX_FRAMES, MAX_VIDEO_BYTES, MAX_VIDEOS, UPLOAD_DAYS, type VideoInput } from "../videos.ts";
import type { ApprovalRequest } from "../permissions.ts";
import { monthSpend } from "../live.ts";
import { RestoreRefused } from "../checkpoints.ts";
import { ParseError } from "../parse.ts";
import { SettingsError } from "../settings.ts";
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

/** A message's attachments together, raw: as base64 in JSON they fit the 112 MB socket frame (src/api.ts). */
export const MAX_MESSAGE_BYTES = 80 * 1024 * 1024;

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
	/** Events for every host watcher that aren't a summary, such as `sandbox.shipped`. */
	const hostListeners = new Set<(event: Json) => void>();
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
		const sandbox = isSandboxSession(record) ? await sandboxOf(record) : undefined;
		return {
			id: record.id,
			title: record.title,
			status: state === "waiting" ? "needsApproval" : state === "running" ? "busy" : sandbox?.held === true ? (record.sandboxState === "failed" ? "stuck" : "busy") : "idle",
			...(sandbox?.held === true && record.sandboxState === "failed" ? { stuck: { reason: "sandbox_failed", detail: record.sandboxReason ?? "" } } : {}),
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
			...(sandbox === undefined ? {} : { sandbox: sandbox.wire, ...(record.source === undefined ? {} : { source: record.source }) }),
			...(allowed.length > 0 ? { alwaysAllowed: allowed } : {}),
		};
	}

	/** Sandbox states on the sandbox host (running, paused, stopped) as last read; refreshed each minute while a client watches. */
	let hostStates = new Map<number, string>();

	/** A sandbox session's `sandbox` for its summary, and whether a message waits for its sandbox. */
	async function sandboxOf(record: SessionRecord): Promise<{ wire: Json; held: boolean }> {
		const held = record.sandbox === undefined && (await host.sandboxes.held(record.id)).length > 0;
		const state = record.sandboxRemoved === true ? "removed"
			: record.sandboxState === "failed" ? "failed"
			: record.sandbox === undefined ? "preparing"
			: hostStates.get(record.sandbox) === "paused" ? "paused"
			: "ready";
		return {
			held,
			wire: {
				number: record.sandboxNumber ?? record.sandbox,
				branch: sandboxBranch(record),
				state,
				...(record.sandboxBase === undefined ? {} : { base: record.sandboxBase }),
				...(state === "preparing" && record.sandboxStep !== undefined ? { step: record.sandboxStep } : {}),
				...(state === "failed" && record.sandboxReason !== undefined ? { reason: record.sandboxReason } : {}),
			},
		};
	}

	/** Reads the sandbox host's states, and marks the sessions whose sandbox paused or woke. */
	async function refreshHostStates() {
		const live = listSummaries().filter((c) => c.sandbox !== undefined && (c.sandbox.state === "ready" || c.sandbox.state === "paused"));
		if (live.length === 0 || hostListeners.size === 0 || host.sandboxSettings() === undefined) return;
		const before = hostStates;
		hostStates = await host.sandboxes.states();
		for (const record of await host.sessions.list()) {
			if (record.sandbox !== undefined && before.get(record.sandbox) !== hostStates.get(record.sandbox)) markDirty(record.id);
		}
	}
	const statePoll = setInterval(() => void refreshHostStates().catch((error) => console.error(`[amyrlin] sandbox states: ${error instanceof Error ? error.message : String(error)}`)), 60_000);
	statePoll.unref();

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

	/** A sandbox session's record, or the error saying it isn't one. */
	async function sandboxSession(id: unknown): Promise<SessionRecord> {
		const { record } = await session(id);
		if (!isSandboxSession(record)) throw new ProtocolError("bad_request", `Session ${record.id} isn't in a sandbox`);
		if (record.source === undefined) throw new ProtocolError("bad_request", `Session ${record.id} is in a sandbox with no project, so it has no branch here`);
		return record;
	}

	/** Runs `work`, answering a git or sandbox refusal (not ready, gone, checked out, rewrote history) as bad_request. */
	async function sandboxCall<T>(work: () => Promise<T>): Promise<T> {
		try {
			return await work();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (/isn't ready|was deleted|checked out|rewrote history|isn't in a sandbox|has no project/.test(message)) throw new ProtocolError("bad_request", message);
			throw error;
		}
	}

	async function checkpointOf(id: number, checkpoint: unknown): Promise<number> {
		if (typeof checkpoint !== "number") throw new ProtocolError("bad_request", "checkpoint should be a number");
		if (!(await host.checkpoints.list(id)).some((c) => c.id === checkpoint)) throw new ProtocolError("not_found", `No checkpoint ${checkpoint}`);
		return checkpoint;
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
		const videos = videosParam(p.videos);
		const files = filesParam(p.files);
		const text = typeof p.text === "string" ? p.text : "";
		const hasFirst = text.trim() !== "" || images.length > 0 || videos.length > 0 || files.length > 0;
		check(images, videos, files);
		const agent: { model?: string; thinking?: Thinking } = {};
		if (p.settings?.model != null) agent.model = modelOf(p.settings.model);
		if (p.settings?.thinkingLevel != null) agent.thinking = thinkingOf(p.settings.thinkingLevel);
		const title = hasFirst ? titleOf(text, images, videos.length, files.map((f) => f.name)) : typeof p.title === "string" && p.title.trim() !== "" ? p.title : "New session";
		if (p.sandbox != null && typeof p.sandbox !== "boolean") throw new ProtocolError("bad_request", "sandbox should be true or false");
		if (p.approvals != null && p.approvals !== "ask" && p.approvals !== "off") throw new ProtocolError("bad_request", "approvals should be ask or off");
		if (p.approvals != null && p.sandbox !== true) throw new ProtocolError("bad_request", "approvals is for a sandbox session");
		const sandboxed = p.sandbox === true;
		if (sandboxed && host.sandboxSettings() === undefined) throw new ProtocolError("unsupported", "This host has no sandbox host in its settings");
		const record = sandboxed ? await host.sessions.startSandbox(project, title, agent, p.approvals == null ? {} : { approvals: p.approvals })
			: project === undefined ? await host.sessions.createScratch(title, agent)
			: await host.sessions.create(project, title, agent);
		await host.root.commit(async (tx) => {
			(await tx.doc(AmyrlinDoc)).created[p.requestId] = record.id;
		}, context);
		let state: "running" | "idle" = hasFirst ? "running" : "idle";
		if (hasFirst) {
			const message = content(text, images, [...(await host.files(record.id, files)), ...(await host.videos(record.id, videos))]);
			const requestId = `${p.requestId}:first`;
			// A sandbox session's first message waits in the database for its sandbox (src/host.ts, hold).
			const held = sandboxed && (await host.sandboxes.hold(record.id, message, requestId, true));
			if (!held) await host.submit(record.id, message, { requestId });
			else {
				state = "idle";
				// The sandbox may have failed before the message was held; watchers hear the session is stuck.
				markDirty(record.id);
			}
		}
		const summary = await summaryOf((await host.sessions.get(record.id)) ?? record, state);
		summaries.set(record.id, summary);
		return { conversation: summary, duplicate: false };
	}

	async function submit(p: Json): Promise<Json> {
		if (typeof p.requestId !== "string" || typeof p.text !== "string") throw new ProtocolError("bad_request", "submit needs requestId and text");
		const images = imagesParam(p.images);
		const videos = videosParam(p.videos);
		const files = filesParam(p.files);
		check(images, videos, files);
		if (p.text.trim() === "" && images.length === 0 && videos.length === 0 && files.length === 0) throw new ProtocolError("bad_request", "the message is empty");
		const whenBusy = p.whenBusy ?? "followUp";
		if (!["followUp", "steer", "reject"].includes(whenBusy)) throw new ProtocolError("bad_request", `whenBusy ${whenBusy}`);
		const { record } = await session(p.conversationId);
		const before = await harness.commit((tx) => tx.submissionByRequest(conversationId(record.id), p.requestId), context);
		if (whenBusy === "reject" && before === undefined && (await host.sessions.states()).get(record.id) !== "idle") {
			throw new ProtocolError("busy", "The session is busy");
		}
		// A retry gets the first message's submission back, whatever it carries, so its files and videos aren't saved again.
		const message = before === undefined ? content(p.text, images, [...(await host.files(record.id, files)), ...(await host.videos(record.id, videos))]) : p.text;
		// A sandbox session's messages wait while its sandbox is made, and are sent in order once it's ready.
		if (before === undefined && isSandboxSession(record) && record.sandbox === undefined) {
			try {
				if (await host.sandboxes.hold(record.id, message, p.requestId)) {
					markDirty(record.id);
					return { submission: { requestId: p.requestId, type: "input", status: "queued" }, duplicate: false };
				}
			} catch (error) {
				if (error instanceof SandboxNotReady) throw new ProtocolError("bad_request", error.message);
				throw error;
			}
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

	/** A message's videos from the app, `[{name, mimeType, data, seconds?, frames?: [{mimeType, data, at}]}]` (src/videos.ts). */
	function videosParam(value: Json): VideoInput[] {
		if (value == null) return [];
		const frame = (f: Json) => typeof f?.mimeType === "string" && typeof f?.data === "string" && typeof f?.at === "number";
		const valid = (v: Json) =>
			typeof v?.name === "string" && typeof v?.mimeType === "string" && typeof v?.data === "string" && (v.seconds == null || typeof v.seconds === "number") && (v.frames == null || (Array.isArray(v.frames) && v.frames.every(frame)));
		if (!Array.isArray(value) || !value.every(valid)) throw new ProtocolError("bad_request", "videos should be a list of {name, mimeType, data, seconds?, frames?}");
		return value.map((v: Json) => ({
			name: v.name,
			mimeType: v.mimeType,
			data: v.data,
			...(v.seconds == null ? {} : { seconds: v.seconds }),
			frames: (v.frames ?? []).map((f: Json) => ({ mimeType: f.mimeType, data: f.data, at: f.at })),
		}));
	}

	/** A message's files from the app, `[{name, mimeType?, data}]` (src/files.ts). */
	function filesParam(value: Json): FileInput[] {
		if (value == null) return [];
		const valid = (f: Json) => typeof f?.name === "string" && typeof f?.data === "string" && (f.mimeType == null || typeof f.mimeType === "string");
		if (!Array.isArray(value) || !value.every(valid)) throw new ProtocolError("bad_request", "files should be a list of {name, mimeType?, data}");
		return value.map((f: Json) => ({ name: f.name, data: f.data, ...(f.mimeType == null ? {} : { mimeType: f.mimeType }) }));
	}

	/** Checks a message's images, videos and files before anything is made or saved; bad_request says what's wrong. */
	function check(images: ImageInput[], videos: VideoInput[], files: FileInput[] = []) {
		try {
			checkImages(images);
			checkVideos(videos);
			checkFiles(files);
			// Everything together fits the socket's frame as base64 (src/api.ts).
			const total = [...images, ...videos, ...videos.flatMap((v) => v.frames ?? []), ...files].reduce((n, a) => n + Buffer.byteLength(a.data, "base64"), 0);
			if (total > MAX_MESSAGE_BYTES) throw new Error(`the attachments are ${(total / 1048576).toFixed(1)} MB together; the limit is ${MAX_MESSAGE_BYTES / 1048576} MB a message`);
		} catch (error) {
			throw new ProtocolError("bad_request", error instanceof Error ? error.message : String(error));
		}
	}

	/** A message's content, or bad_request saying what's wrong with it. */
	function content(text: string, images: ImageInput[], after: Parameters<typeof messageContent>[2] = []) {
		try {
			return messageContent(text, images, after);
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
			// Messages take videos (src/videos.ts); a host from before them leaves this out, and the app sends it none.
			videos: { maxVideos: MAX_VIDEOS, maxBytes: MAX_VIDEO_BYTES, maxFrames: MAX_FRAMES, keepDays: UPLOAD_DAYS },
			// Messages take files, and long text becomes one (src/files.ts); a host from before them leaves this out.
			// Sessions can publish pages (src/pages.ts); conversation.page fetches one.
			pages: true,
			files: { maxFiles: MAX_FILES, maxBytes: MAX_FILE_BYTES, pasteBytes: PASTE_BYTES, keepDays: UPLOAD_DAYS, maxMessageBytes: MAX_MESSAGE_BYTES },
			// Sessions may run in sandboxes (protocol section 10 item 19); a host without a sandbox host leaves this out.
			...sandboxInfo(),
			...(await monthCostOf()),
		};
	}

	function sandboxInfo(): Json {
		const settings = host.sandboxSettings();
		return settings === undefined ? {} : { sandboxes: { shipTo: settings.shipTo, afterRun: settings.afterRun } };
	}

	/** `sandbox.shipped` for host watchers. */
	function shippedEvent(id: number, result: ShipResult): Json {
		return result.shipped
			? { type: "sandbox.shipped", conversationId: id, shipped: true, to: result.mode, pushed: result.pushed, head: result.head, commits: result.commits, ...(result.pr === undefined ? {} : { pr: result.pr }) }
			: { type: "sandbox.shipped", conversationId: id, shipped: false, kind: result.kind, reason: result.reason };
	}
	const stopShipped = host.ships.onShipped((id, result) => {
		markDirty(id);
		const event = shippedEvent(id, result);
		for (const listener of hostListeners) listener(event);
	});

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
						const onHostEvent = (event: Json) => void send([event]);
						let stopColors = () => {};
						subscriptions.set(id, async () => {
							summaryListeners.delete(onSummary);
							hostListeners.delete(onHostEvent);
							stopColors();
						});
						respond({ subscription: id });
						await send([{ type: "host.snapshot", host: await identity(), spend: await hostSpend(), ...(await monthCostOf()), conversations: listSummaries(), projectColors: await host.colors.list() }]);
						summaryListeners.add(onSummary);
						hostListeners.add(onHostEvent);
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
				case "conversations.retitle": {
					// aludra's own: the title written again from the whole conversation, replacing any title.
					const { record } = await session(p.conversationId);
					let written;
					try {
						written = await host.sessions.regenerateTitle(record.id);
					} catch (error) {
						if (error instanceof ParseError) throw new ProtocolError("bad_request", error.message);
						throw error;
					}
					const current = written ?? record;
					const summary = await summaryOf(current, (await host.sessions.states()).get(current.id) ?? "idle");
					if (written !== undefined) publishSummary(summary);
					return { conversation: summary, written: written !== undefined };
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
				case "settings.get":
					return { settings: host.settings.get() };
				case "settings.set": {
					if (p.changes === null || typeof p.changes !== "object" || Array.isArray(p.changes)) throw new ProtocolError("bad_request", "settings.set takes changes: { key: value or null }");
					try {
						return { settings: host.settings.set(p.changes) };
					} catch (error) {
						if (error instanceof SettingsError) throw new ProtocolError("invalid_settings", error.message, { errors: error.errors });
						throw error;
					}
				}
				// aludra's own: a page the agent published (src/pages.ts), sealed HTML for a web view.
				case "conversation.page": {
					const { record } = await session(p.conversationId);
					if (typeof p.page !== "number") throw new ProtocolError("bad_request", "conversation.page takes a page number");
					const found = await host.page(record.id, p.page);
					if (found === undefined) throw new ProtocolError("not_found", `No page ${p.page} in session ${record.id}`);
					return { page: found.page, title: found.title, html: found.html, bytes: found.bytes, createdAt: found.createdAt, csp: PAGE_CSP };
				}
				// aludra's own: messages and answers matching a query, across sessions or in one.
				case "messages.search": {
					if (typeof p.query !== "string") throw new ProtocolError("bad_request", "messages.search takes a query");
					if (p.conversationId !== undefined) await session(p.conversationId);
					const limit = typeof p.limit === "number" ? p.limit : 50;
					return { results: await host.search(p.query, { limit, ...(p.conversationId === undefined ? {} : { session: p.conversationId }) }) as unknown as Json };
				}
				// aludra's own: a session's checkpoints, a checkpoint's changes or one file's diff, and restoring one.
				case "checkpoints.list": {
					const { record } = await session(p.conversationId);
					return { checkpoints: await host.checkpoints.list(record.id) as unknown as Json };
				}
				case "checkpoints.changes": {
					const { record } = await session(p.conversationId);
					const checkpoint = await checkpointOf(record.id, p.checkpoint);
					if (p.path === undefined) return { changes: await host.checkpoints.changes(record.id, checkpoint) as unknown as Json };
					if (typeof p.path !== "string") throw new ProtocolError("bad_request", "path should be a string");
					try {
						return { path: p.path, patch: await host.checkpoints.diff(record.id, checkpoint, p.path) };
					} catch (error) {
						throw new ProtocolError("not_found", error instanceof Error ? error.message : String(error));
					}
				}
				case "checkpoints.restore": {
					const { record } = await session(p.conversationId);
					const checkpoint = await checkpointOf(record.id, p.checkpoint);
					try {
						return await host.checkpoints.restore(record.id, checkpoint) as unknown as Json;
					} catch (error) {
						if (error instanceof RestoreRefused) throw new ProtocolError("busy", error.message);
						throw error;
					}
				}
				// aludra's own: sandbox tasks (protocol section 10 item 19).
				case "sandbox.sync": {
					const record = await sandboxSession(p.conversationId);
					if (p.merge != null && typeof p.merge !== "boolean") throw new ProtocolError("bad_request", "merge should be true or false");
					const synced = await sandboxCall(() => host.sandboxes.sync(record.id, undefined, { merge: p.merge === true }));
					markDirty(record.id);
					return {
						branch: synced.branch,
						head: synced.head,
						commits: synced.commits,
						uncommitted: synced.uncommitted,
						...(synced.merge === undefined ? {} : { merged: synced.merge.merged ? true : { reason: synced.merge.reason } }),
					};
				}
				case "sandbox.ship": {
					const record = await sandboxSession(p.conversationId);
					if (p.to != null && p.to !== "main" && p.to !== "branch") throw new ProtocolError("bad_request", "to should be main or branch");
					if (p.note != null && typeof p.note !== "string") throw new ProtocolError("bad_request", "note should be text");
					try {
						await host.ships.start(record.id, { mode: p.to ?? host.shipMode(), ...(p.note == null ? {} : { note: p.note }) });
					} catch (error) {
						if (error instanceof ShipRefused) throw new ProtocolError(error.code, error.message);
						throw error;
					}
					return { started: true };
				}
				case "sandbox.discard": {
					const record = await sandboxSession(p.conversationId);
					const discarded = await sandboxCall(() => host.sandboxes.discard(record.id));
					return { branch: discarded.branch, deleted: discarded.head !== undefined };
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
			clearInterval(statePoll);
			stopShipped();
			stopApprovals();
			stopCommits();
			stopCreated();
			stopUpdated();
		},
	};
}
