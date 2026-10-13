// Protocol v1 translation (amyrlin's docs/protocol.md, sections 4, 6.1 and 7): pi-durable 1.1.0 watchEvents() output
// into the frames the amyrlin Mac app reads. Ported from amyrlin's server/src/translate.mjs; test/amyrlin.test.ts checks
// it against amyrlin's recorded fixtures and their expected translation, frame by frame.
//
// The endpoint passes hooks for what watchEvents() doesn't carry: the session's title, inbox text, resolved settings
// and pending approvals. Without hooks, approvals come from the recorder's notes in the fixtures (12, 15 and 16).

/**
 * Untyped JSON. Everything here reads and writes wire JSON whose shapes the fixtures pin down, not types: pi-durable's
 * events go in, protocol v1 events come out, and both are checked against recordings by the tests.
 */
// oxlint-disable-next-line typescript/no-explicit-any
export type Json = any;

const has = (object: Json, key: string): boolean => object !== null && typeof object === "object" && key in object;
const setIf = (target: Json, key: string, value: Json): void => {
	if (value !== undefined) target[key] = value;
};

export type TranslatorHooks = {
	conversation?: () => Json;
	inboxExtra?: (submissionId: number) => { text?: string; kind?: string } | undefined;
	settings: (agent: Json) => Json;
	approvals?: () => Json[];
};

export class DurableTranslator {
	readonly conversationId: number;
	readonly title: string;
	readonly hooks: TranslatorHooks;
	#requestIds = new Map<number, string>(); // submission ID → requestId (section 4.6)
	#toolCalls = new Map<string, { name: string; args: Json }>(); // callId → name and arguments
	#pendingApprovals = new Map<string, Json>(); // approvalId → approval (section 8)

	/**
	 * @param {object} [options]
	 * @param {number} [options.conversationId]
	 * @param {string} [options.title]
	 * @param {() => object} [options.conversation] the snapshot's `conversation` field
	 * @param {(submissionId: number) => object | undefined} [options.inboxExtra] `text` and `kind` of a queued item
	 * @param {(agent: object) => object} [options.settings] stored and effective settings for a `pi.agent` value
	 * @param {() => object[]} [options.approvals] pending approvals, replacing the note-derived ones
	 */
	constructor({ conversationId = 1, title = "Fixture", conversation, inboxExtra, settings: settingsHook, approvals }: Partial<TranslatorHooks> & { conversationId?: number; title?: string } = {}) {
		this.conversationId = conversationId;
		this.title = title;
		this.hooks = { settings: settingsHook ?? settings };
		if (conversation !== undefined) this.hooks.conversation = conversation;
		if (inboxExtra !== undefined) this.hooks.inboxExtra = inboxExtra;
		if (approvals !== undefined) this.hooks.approvals = approvals;
	}

	/** The wire frames for one fixture line, each an array of events. */
	frames(line: Json): Json[][] {
		if (has(line, "snapshot")) return [[this.#snapshot(line.snapshot)]];
		if (Array.isArray(line.batch)) {
			const events = line.batch.flatMap((event: Json) => this.#event(event));
			return events.length === 0 ? [] : [events];
		}
		if (typeof line.note === "string") {
			const event = this.#note(line.note, line.data);
			return event === undefined ? [] : [[event]];
		}
		return [];
	}

	// Snapshot (section 6.1)

	#snapshot(s: Json): Json {
		const entries: Json[] = s.entries ?? [];
		for (const entry of entries) this.#learn(entry);
		const tools: Json[] = [];
		for (const slot of s.tools ?? []) {
			if (slot.status === "running") tools.push(this.#slot(slot, "running"));
			else if (slot.status === "done" && slot.entry === undefined) tools.push(this.#slot(slot, "ended"));
			// pending, and done with a result entry, are omitted (section 4.5)
		}
		const generation = s.generation;
		const streaming =
			generation?.message !== undefined
				? { attempt: generation.attempt ?? 1, content: content(generation.message.content), model: modelRef(generation.message) }
				: null;
		const retry =
			generation?.retry !== undefined
				? { attempt: generation.attempt ?? 1, at: generation.retry.at ?? null, error: generation.retry.error ?? null }
				: null;
		return {
			type: "snapshot",
			conversation: this.hooks.conversation?.() ?? { id: this.conversationId, title: this.title, archived: false, parent: null },
			items: entries.map((entry) => entryItem(entry)).filter((item) => item !== undefined),
			hasEarlier: false,
			contextStart: entries[0]?.head ?? null,
			run: s.run !== undefined ? { inputs: s.run.inputs ?? [] } : null,
			streaming,
			retry,
			tools,
			inbox: (s.inbox ?? []).map((item: Json) => this.#inboxItem(item)),
			approvals: this.hooks.approvals?.() ?? [...this.#pendingApprovals.keys()].sort().map((id) => this.#pendingApprovals.get(id)),
			compactions: (s.compactions ?? []).map((c: Json) => ({
				taskId: c.taskId ?? null,
				reason: c.reason ?? "",
				blocking: c.blocking ?? false,
				attempt: c.attempt ?? null,
				retry: c.retry ?? null,
			})),
			settings: this.hooks.settings(s.agent ?? {}),
			spend: usageState(s.usage),
		};
	}

	#slot(slot: Json, status: string): Json {
		return {
			callId: slot.callId ?? "",
			name: slot.name ?? "",
			status,
			output: slot.output ?? "",
			droppedBytes: slot.droppedBytes ?? 0,
			droppedLines: slot.droppedLines ?? 0,
			details: slot.details ?? null,
			diagnostics: slot.diagnostics ?? [],
		};
	}

	#inboxItem(item: Json): Json {
		const out: Json = { submissionId: item.id ?? null, mode: item.mode ?? "" };
		setIf(out, "requestId", this.#requestIds.get(item.id));
		const extra = this.hooks.inboxExtra?.(item.id);
		setIf(out, "text", extra?.text);
		setIf(out, "kind", extra?.kind);
		return out;
	}

	// Events (section 7.1)

	#event(e: Json): Json[] {
		switch (e.type) {
			case "snapshot":
				return [this.#snapshot(e)];
			case "run_start":
				return [{ type: "run.started", inputs: e.inputs ?? [] }];
			case "run_end":
				return [{ type: "run.ended", inputs: e.inputs ?? [] }];
			case "turn_start":
			case "turn_end":
			case "deferred_poll":
				return [];
			case "message_start":
				if (e.message?.role !== "assistant") return [];
				return [{ type: "stream.started", attempt: 1, content: content(e.message.content), model: modelRef(e.message) }];
			case "message_update": {
				const ops = (e.changes ?? []).map(change);
				return ops.length === 0 ? [] : [{ type: "stream.delta", ops }];
			}
			case "message_end":
			case "entry_appended": {
				this.#learn(e.entry ?? {});
				const item = entryItem(e.entry ?? {});
				return item === undefined ? [] : [{ type: "item.added", item }];
			}
			case "tool_execution_start":
				return [{ type: "tool.started", callId: e.toolCallId ?? "", name: e.toolName ?? "", args: e.args ?? {} }];
			case "tool_execution_update": {
				const out: Json = { type: "tool.updated", callId: e.toolCallId ?? "" };
				for (const key of ["output", "details", "diagnostics"]) setIf(out, key, e[key]);
				return [out];
			}
			case "tool_execution_end": {
				const out: Json = { type: "tool.ended", callId: e.toolCallId ?? "" };
				setIf(out, "resultId", e.entry?.id);
				return [out];
			}
			case "inbox_update":
				return [{ type: "inbox.changed", items: (e.items ?? []).map((item: Json) => this.#inboxItem(item)) }];
			case "submission": {
				const r = e.record ?? {};
				if (typeof r.requestId === "string") this.#requestIds.set(r.id, r.requestId);
				const s: Json = { id: r.id ?? null, type: r.type ?? "", status: r.status ?? "" };
				setIf(s, "requestId", r.requestId);
				setIf(s, "entryId", r.entry);
				setIf(s, "answerId", r.answer);
				setIf(s, "reason", r.reason);
				setIf(s, "detail", r.detail);
				return [{ type: "submission", submission: s }];
			}
			case "agent_changed":
				return [{ type: "settings.changed", settings: this.hooks.settings(e.agent ?? {}) }];
			case "usage_changed":
				return [{ type: "spend.changed", spend: usageState(e.usage) }];
			case "compaction_start":
				return [{ type: "compaction.started", taskId: e.taskId ?? null, reason: e.reason ?? "", blocking: e.blocking ?? false }];
			case "compaction_end":
				return [{ type: "compaction.ended", taskId: e.taskId ?? null, reason: e.reason ?? "" }];
			case "auto_retry_start":
				return [{ type: "retry.scheduled", attempt: e.attempt ?? null, at: e.at ?? null, error: e.errorMessage ?? "" }];
			case "auto_retry_end":
				return [{ type: "retry.cleared", attempt: e.attempt ?? null }];
			case "task_failed":
				return [{ type: "task.failed", taskId: e.taskId ?? null, kind: e.kind ?? "", message: e.message ?? "" }];
			default:
				throw new Error(`durable event type ${e.type} has no mapping in protocol section 7.1`);
		}
	}

	// Approvals (section 8), from recorder notes. A real server raises these from its beforeTool hook.

	#note(note: string, data: Json): Json {
		if (this.hooks.approvals !== undefined) return undefined;
		if (note.startsWith("beforeTool hook entered") && typeof data?.toolCallId === "string") {
			const callId = data.toolCallId;
			const approvalId = `${this.conversationId}:${callId}`;
			const call = this.#toolCalls.get(callId);
			const approval = {
				approvalId,
				conversationId: this.conversationId,
				callId,
				toolName: call?.name ?? "",
				args: call?.args ?? {},
				requestedAt: 0,
			};
			this.#pendingApprovals.set(approvalId, approval);
			return { type: "approval.requested", approval };
		}
		const decision = ({ approved: "approve", "hook wait ended": "cancelled" } as Record<string, string>)[note];
		const approvalId = [...this.#pendingApprovals.keys()].sort()[0];
		if (decision !== undefined && approvalId !== undefined) {
			this.#pendingApprovals.delete(approvalId);
			return { type: "approval.resolved", approvalId, decision };
		}
		// A killed process loses its in-memory approvals; the next process raises them again.
		if (note.includes("killed")) this.#pendingApprovals.clear();
		return undefined;
	}

	#learn(entry: Json): void {
		if (entry.kind !== "pi.assistant") return;
		for (const block of entry.model?.[0]?.content ?? []) {
			if (block?.type === "toolCall" && typeof block.id === "string") {
				this.#toolCalls.set(block.id, { name: block.name ?? "", args: block.arguments ?? {} });
			}
		}
	}
}

// Entries (section 4.3)

export function entryItem(entry: Json): Json {
	const kind = entry.kind ?? "";
	const message = entry.model?.[0];
	const item: Json = { id: entry.id ?? null };
	setIf(item, "at", message?.timestamp);
	switch (kind) {
		case "pi.system":
			return undefined;
		case "pi.assistant": {
			const m = message ?? {};
			item.type = "assistant";
			item.content = content(m.content);
			setIf(item, "stopReason", m.stopReason);
			item.model = modelRef(m);
			if (m.usage !== undefined) item.spend = usage(m.usage);
			setIf(item, "error", m.errorMessage);
			break;
		}
		case "pi.tool-result": {
			const m = message ?? {};
			item.type = "toolResult";
			setIf(item, "callId", m.toolCallId);
			setIf(item, "toolName", m.toolName);
			item.content = content(m.content);
			setIf(item, "isError", m.isError);
			setIf(item, "details", m.details);
			item.diagnostics = entry.data?.diagnostics ?? [];
			setIf(item, "durationMs", m.durationMs);
			break;
		}
		case "pi.reset":
			item.type = "reset";
			if (message !== undefined) item.handoff = text(message.content);
			item.contextStart = entry.head ?? entry.id ?? null;
			break;
		case "pi.compaction":
			item.type = "compaction";
			item.summary = text(message?.content);
			item.reason = entry.data?.reason ?? "";
			setIf(item, "contextStart", entry.head);
			break;
		default:
			if (message?.role === "user") {
				item.type = "user";
				item.content = content(message.content);
				if (kind !== "pi.user") {
					item.kind = kind;
					setIf(item, "data", entry.data);
				}
			} else {
				item.type = "custom";
				item.kind = kind;
				setIf(item, "data", entry.data);
			}
	}
	return item;
}

function change(c: Json): Json {
	const index = c.contentIndex ?? null;
	switch (c.type) {
		case "text_start":
		case "thinking_start":
		case "toolcall_start":
			return { op: "start", index, block: block(c.block ?? null) };
		case "text_delta":
		case "thinking_delta":
			return { op: "appendText", index, text: c.delta ?? "" };
		case "toolcall_delta":
			return { op: "appendArg", index, path: c.path ?? [], text: c.delta ?? "" };
		case "block":
			return { op: "set", index, block: block(c.block ?? null) };
		case "message":
			return { op: "replace", content: content(c.message?.content) };
		default:
			throw new Error(`message change ${c.type} has no mapping in protocol section 7.2`);
	}
}

function content(value: Json): Json[] {
	if (typeof value === "string") return [{ type: "text", text: value }];
	if (Array.isArray(value)) return value.map(block);
	return [];
}

function block(b: Json): Json {
	switch (b?.type) {
		case "text":
			return { type: "text", text: b.text ?? "" };
		case "thinking":
			return { type: "thinking", text: b.thinking ?? "", redacted: b.redacted ?? false };
		case "toolCall":
			return { type: "toolCall", id: b.id ?? "", name: b.name ?? "", args: b.arguments ?? {} };
		case "image":
			return { type: "image", mimeType: b.mimeType ?? "" };
		default:
			return { type: b?.type ?? "" };
	}
}

export function text(value: Json): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.filter((b: Json) => b?.type === "text").map((b: Json) => b.text ?? "").join("");
	return "";
}

function modelRef(message: Json): Json {
	return { provider: message.provider ?? "", modelId: message.model ?? "" };
}

export function settings(agent: Json): Json {
	const stored: Json = {};
	for (const key of ["model", "thinkingLevel", "cwd", "tools", "instructions"]) setIf(stored, key, agent[key]);
	const { instructions: _instructions, ...effective } = stored;
	effective.tools = [];
	return { stored, effective };
}

// Spend (section 4.2)

const SPEND_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "total", "cost"];

export function usage(u: Json): Json {
	return {
		input: u.input ?? 0,
		output: u.output ?? 0,
		cacheRead: u.cacheRead ?? 0,
		cacheWrite: u.cacheWrite ?? 0,
		total: u.totalTokens ?? 0,
		cost: u.cost?.total ?? 0,
	};
}

export function usageState(state: Json): Json {
	const totals = Object.fromEntries(SPEND_FIELDS.map((field) => [field, 0]));
	const out: Json = {};
	for (const [bucket, key] of [
		["models", "byModel"],
		["tools", "byTool"],
	]) {
		const mapped: Json = {};
		for (const [name, u] of Object.entries<Json>(state?.[bucket] ?? {})) {
			mapped[name] = usage(u);
			for (const field of SPEND_FIELDS) totals[field] += mapped[name][field];
		}
		out[key] = mapped;
	}
	return { ...out, ...totals };
}

/** Reads a fixture file and translates it into timed frames: [{ t, events }]. */
export function translateFixture(text: string, options?: ConstructorParameters<typeof DurableTranslator>[0]): { t: number; events: Json[] }[] {
	const translator = new DurableTranslator(options);
	const frames: { t: number; events: Json[] }[] = [];
	for (const line of text.split("\n")) {
		if (line.trim() === "") continue;
		const parsed = JSON.parse(line);
		for (const events of translator.frames(parsed)) frames.push({ t: parsed.t ?? 0, events });
	}
	return frames;
}
