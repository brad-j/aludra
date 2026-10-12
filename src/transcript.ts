// A session's transcript as the app shows it: Pi Durable's view (entries and the live document) turned into a list of
// items, with what's running overlaid. The app gets these over the WebSocket (src/api.ts).
import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import type { ConversationView, InboxState, LiveState } from "@earendil-works/pi-durable";
import type { Item, SessionState } from "./api-types.ts";

/** Longest string sent for a call's argument or output; output keeps its tail, arguments their head. */
const MAX_TEXT = 6000;

const cutHead = (text: string) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n… (${text.length - MAX_TEXT} more characters)` : text);
const cutTail = (text: string) => (text.length > MAX_TEXT ? `… (${text.length - MAX_TEXT} characters before)\n${text.slice(-MAX_TEXT)}` : text);

function cutArgs(args: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(args).map(([key, value]) => {
		if (typeof value === "string") return [key, cutHead(value)];
		if (Array.isArray(value)) return [key, value.map((v) => (v !== null && typeof v === "object" ? cutArgs(v as Record<string, unknown>) : v))];
		return [key, value];
	}));
}

export function textOf(content: Message["content"]): string {
	if (typeof content === "string") return content;
	return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

/** What kind of failure an assistant error is, and its request ID if it names one. */
export function classifyFailure(message: string): { type: "refused" | "rate-limit" | "error"; requestId?: string } {
	const requestId = /\breq_[A-Za-z0-9]+/.exec(message)?.[0];
	const type = /safeguard|usage polic|refus|\[cyber\]|content filter/i.test(message) ? "refused" : /rate limit|out of (extra )?usage|429/i.test(message) ? "rate-limit" : "error";
	return requestId === undefined ? { type } : { type, requestId };
}

/** The items of one assistant message: text as answers, tool calls as calls, then its failure if it failed. */
function assistantItems(message: AssistantMessage, key: string, results: Map<string, ToolResultMessage>, streaming: boolean): Item[] {
	const items: Item[] = [];
	message.content.forEach((block, index) => {
		if (block.type === "text" && block.text.trim() !== "") {
			items.push({ kind: "answer", id: `${key}:${index}`, text: block.text, at: message.timestamp, ...(streaming ? { streaming: true } : {}) });
		} else if (block.type === "toolCall") {
			const result = results.get(block.id);
			const output = result === undefined ? undefined : cutTail(textOf(result.content));
			items.push({
				kind: "call",
				id: block.id,
				tool: block.name,
				args: cutArgs(block.arguments),
				status: result === undefined ? "pending" : result.isError ? "error" : "done",
				...(output === undefined ? {} : { output }),
				...(result === undefined ? {} : { ms: (result as ToolResultMessage & { durationMs?: number }).durationMs ?? Math.max(0, result.timestamp - message.timestamp) }),
			});
		}
	});
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		const text = message.errorMessage ?? (message.stopReason === "aborted" ? "Stopped" : "The model failed without saying why");
		const failure = message.stopReason === "aborted" ? { type: "stopped" as const } : classifyFailure(text);
		items.push({ kind: "failure", id: `${key}:failure`, message: text, at: message.timestamp, ...failure });
	}
	return items;
}

/** The transcript, in order, with running calls and the answer being written overlaid from the live document. */
export function itemsOf(view: ConversationView): Item[] {
	const results = new Map<string, ToolResultMessage>();
	for (const entry of view.entries) {
		for (const message of entry.model ?? []) if (message.role === "toolResult") results.set(message.toolCallId, message);
	}
	const items: Item[] = [];
	for (const entry of view.entries) {
		if (entry.kind === "pi.compaction") {
			items.push({ kind: "compacted", id: `e${entry.id}`, at: 0 });
			continue;
		}
		for (const [index, message] of (entry.model ?? []).entries()) {
			if (message.role === "user" && entry.kind === "pi.user") items.push({ kind: "user", id: `e${entry.id}:${index}`, text: textOf(message.content), at: message.timestamp });
			else if (message.role === "assistant") items.push(...assistantItems(message, `e${entry.id}:${index}`, results, false));
		}
	}

	// SAFETY: a document in the view is the JSON of its kind's state.
	const live = view.docs["pi.live"] as LiveState | undefined;
	if (live?.tools !== undefined) {
		for (const slot of live.tools) {
			const item = items.find((i) => i.kind === "call" && i.id === slot.callId);
			if (item?.kind !== "call" || item.status === "done" || item.status === "error") continue;
			if (slot.status === "running") item.status = "running";
			if (slot.output !== undefined && slot.output !== "") item.output = cutTail(slot.output);
		}
	}
	const partial = live?.generation?.message;
	// SAFETY: the live partial is the JSON of an assistant message.
	if (partial !== undefined) items.push(...assistantItems(partial as unknown as AssistantMessage, "live", results, true));
	// A run that ended on a tool result, with nothing running, was stopped between the call and the next answer.
	const last = lastMessage(view);
	if (live?.run === undefined && last?.role === "toolResult") items.push({ kind: "failure", id: `${last.toolCallId}:stopped`, type: "stopped", message: "Stopped", at: last.timestamp });
	return items;
}

function lastMessage(view: ConversationView): Message | undefined {
	for (let i = view.entries.length - 1; i >= 0; i--) {
		const entry = view.entries[i]!;
		if (entry.kind === "pi.user" || entry.kind === "pi.assistant" || entry.kind === "pi.tool-result") return entry.model?.at(-1);
	}
	return undefined;
}

/** Whether a session's run is going, waits for Brad, or how it last ended. */
export function stateOf(view: ConversationView, waiting: boolean): SessionState {
	if (waiting) return "waiting";
	// SAFETY: a document in the view is the JSON of its kind's state.
	const live = view.docs["pi.live"] as LiveState | undefined;
	if (live?.run !== undefined || (live?.compactions?.length ?? 0) > 0) return "running";
	if (lastMessage(view)?.role === "toolResult") return "stopped";
	const last = [...view.entries].reverse().flatMap((e) => e.model ?? []).find((m) => m.role === "assistant");
	if (last === undefined) return view.entries.some((e) => e.kind === "pi.user") ? "failed" : "idle";
	if (last.stopReason === "error") return "failed";
	if (last.stopReason === "aborted") return "stopped";
	return "done";
}

/** The session's latest activity in a line. */
export function lineOf(items: readonly Item[], state: SessionState): string {
	const last = items.at(-1);
	if (last === undefined) return state === "running" ? "Starting" : "";
	const first = (text: string) => text.trim().split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
	switch (last.kind) {
		case "user":
			return state === "running" ? "Thinking" : first(last.text);
		case "answer":
			return first(last.text).replace(/[*_`#>]/g, "");
		case "call":
			return `${last.tool} ${callLabel(last)}`;
		case "failure":
			return last.type === "refused" ? `Refused by safeguards${last.requestId === undefined ? "" : ` · ${last.requestId}`}` : last.type === "stopped" ? "Stopped" : first(last.message);
		case "compacted":
			return "Compacted";
	}
}

/** A call in a few words: the command, the path, or its arguments. */
export function callLabel(call: Extract<Item, { kind: "call" }>): string {
	const { command, path } = call.args;
	if (typeof command === "string") return command.split("\n")[0]!;
	if (typeof path === "string") return path;
	return JSON.stringify(call.args).slice(0, 120);
}

/** The newest timestamp in the transcript. */
export function updatedAt(view: ConversationView, fallback: number): number {
	let newest = fallback;
	for (const entry of view.entries) for (const message of entry.model ?? []) newest = Math.max(newest, message.timestamp);
	return newest;
}

/** Tokens the last request used: its input, cached or not, and its output. */
export function contextUsed(view: ConversationView): number {
	// SAFETY: a document in the view is the JSON of its kind's state.
	const partial = (view.docs["pi.live"] as LiveState | undefined)?.generation?.message as unknown as AssistantMessage | undefined;
	const last = partial ?? [...view.entries].reverse().flatMap((e) => e.model ?? []).find((m): m is AssistantMessage => m.role === "assistant");
	if (last?.usage === undefined) return 0;
	return last.usage.input + last.usage.cacheRead + last.usage.cacheWrite + last.usage.output;
}

/** What waits in the inbox, oldest first. */
export function queuedOf(view: ConversationView): { id: number; mode: "steer" | "followUp"; text: string }[] {
	// SAFETY: a document in the view is the JSON of its kind's state.
	const inbox = view.docs["pi.inbox"] as InboxState | undefined;
	return (inbox?.items ?? []).flatMap((item) =>
		// SAFETY: a queued input's content is the JSON of a user message's content.
		item.mode === "write" ? [] : [{ id: Number(item.id), mode: item.mode, text: textOf(item.content as unknown as Message["content"]) }]);
}

/** Where the transcript first differs from the one sent before, so only the rest is sent again. */
export function firstChange(before: readonly string[], after: readonly string[]): number {
	const length = Math.min(before.length, after.length);
	for (let i = 0; i < length; i++) if (before[i] !== after[i]) return i;
	return length;
}
