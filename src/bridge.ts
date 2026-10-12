// The model provider: pi-claude-bridge, which drives Claude Code through the Agent SDK on Brad's subscription.
//
// The bridge is a pi extension, written for pi's agent loop, not Pi Durable's. It loads through jiti with a stand-in
// for pi's ExtensionAPI that keeps its provider and its event handlers. bridgeProvider wraps the provider's
// streamSimple with the fixes Pi Durable needs (docs/plan.md, "Spike findings" and milestone 1):
//
// - Signals. Pi Durable aborts each request's signal once that request is done, but the bridge keeps one Claude Code
//   query alive across tool calls and ties it to the first request's signal. One controller per session is forwarded
//   an abort only while a stream is running; `abort()` ends a session's query between requests.
// - Restarts. With no live query, a transcript ending in a tool result takes the bridge's "orphaned tool result" path
//   and ends the turn empty. When the bridge has no query parked for the session, a short user note goes on that one
//   request (not stored), which sends it down its rebuild path instead.
// - History rewrites. Pi Durable's compaction and reset replace the head of the history. In pi, the bridge hears of
//   that through session_compact and rebuilds Claude Code's session; here the wrapper notices the head change and
//   calls the bridge's own session_compact handler.
// - The system prompt. The bridge only sends a system prompt it recorded from pi's events, and fails the turn
//   otherwise. Each request's prompt is recorded as a custom prompt, so Claude Code gets all of it after its preset.
// - The working directory. The bridge runs Claude Code in process.cwd() (its session files, its environment section).
//   streamSimple reads it synchronously, so the wrapper changes into the conversation's directory around the call.
//
// These depend on bridge internals (src/transcript.ts, src/prompt-capture.ts and its event handlers), so the bridge is
// pinned; upgrade it deliberately and rerun scripts/live-check.ts.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, AssistantMessageEventStream, Model, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai/models";
import { AgentDoc, defineExtension, GenerationTask, hook, ProviderDoc } from "@earendil-works/pi-durable";

export const PROVIDER = "claude-bridge";
export const RECOVERY_NOTE = "(Continuing where we left off.)";

type StreamFn = (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) => AssistantMessageEventStream;
type Handler = (event: object, ctx: object) => unknown;

/** What aludra uses of the bridge. Tests give a fake. */
export type Bridge = {
	/** The provider the bridge registered with pi. */
	models: readonly Model<Api>[];
	streamSimple: StreamFn;
	/** The handlers the bridge registered with `pi.on`, by event. */
	handlers: ReadonlyMap<string, readonly Handler[]>;
	/** The system prompt the bridge will look up for this request. */
	systemPromptOf(context: TranscriptContext): string | undefined;
	/** Records `prompt` with the bridge as a custom prompt, so Claude Code gets it whole. */
	recordPrompt(prompt: string): void;
};

/** A notice the bridge meant for pi's UI, such as a rate-limit warning. */
export type Notice = { message: string; level: string };

const resolveFile = (specifier: string) => fileURLToPath(import.meta.resolve(specifier));

// The bridge registers its provider once per process (a second load defers to pi's session_start), so it's loaded once
// and its notices go to everyone who loaded it.
let loading: Promise<Bridge> | undefined;
const listeners = new Set<(notice: Notice) => void>();

/** The bridge, loaded as pi would load it, keeping its provider and handlers. `notify` gets what it would show in pi's UI. */
export function loadBridge(notify: (notice: Notice) => void): Promise<Bridge> {
	listeners.add(notify);
	loading ??= load((notice) => listeners.forEach((listener) => listener(notice)));
	return loading;
}

async function load(notify: (notice: Notice) => void): Promise<Bridge> {
	const { createJiti } = await import("jiti");
	// The bridge's imports of pi's packages get the copies Pi Durable uses.
	const jiti = createJiti(import.meta.url, {
		alias: {
			"@earendil-works/pi-ai/compat": resolveFile("@earendil-works/pi-ai/compat"),
			"@earendil-works/pi-ai": resolveFile("@earendil-works/pi-ai"),
			"@earendil-works/pi-coding-agent": resolveFile("@earendil-works/pi-coding-agent"),
			"@earendil-works/pi-tui": resolveFile("@earendil-works/pi-tui"),
		},
	});
	const src = join(dirname(resolveFile("pi-claude-bridge/package.json")), "src");
	const register = await jiti.import<(pi: object) => void | Promise<void>>(join(src, "index.ts"), { default: true });
	const transcript = await jiti.import<{ toBridgeContext(context: TranscriptContext): { systemPrompt?: string } }>(join(src, "transcript.ts"));
	const captures = await jiti.import<{
		sharedPromptCaptures(): { record(prompt: string, input: { custom: string; contextFiles: []; skills: [] }, source: string): void };
	}>(join(src, "prompt-capture.ts"));

	let provider: { models: Model<Api>[]; streamSimple: StreamFn } | undefined;
	const handlers = new Map<string, Handler[]>();
	const api = new Proxy({}, {
		get: (_, key) => {
			if (key === "registerProvider") return (_id: string, config: typeof provider) => (provider = config);
			if (key === "on") return (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			return () => undefined;
		},
	});
	await register(api);
	if (provider === undefined) throw new Error("pi-claude-bridge registered no provider");
	// Gives the bridge somewhere to send its notices. "rpc" keeps its startup notice for pi's terminal UI.
	const ui = { notify: (message: string, level = "info") => notify({ message, level }) };
	for (const handler of handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" }, { ui, mode: "rpc" });

	const shared = captures.sharedPromptCaptures();
	return {
		models: provider.models,
		streamSimple: provider.streamSimple,
		handlers,
		systemPromptOf: (context) => transcript.toBridgeContext(context).systemPrompt,
		recordPrompt: (prompt) => shared.record(prompt, { custom: prompt, contextFiles: [], skills: [] }, "aludra"),
	};
}

/** The first message after the system prompt, which a compaction or reset replaces. */
function headOf(context: TranscriptContext): string | undefined {
	const head = context.messages.find((message) => message.role !== "system");
	return head === undefined ? undefined : `${head.role} ${head.timestamp} ${JSON.stringify(head.content).slice(0, 500)}`;
}

/** The bridge as a pi-ai provider for Pi Durable, with the fixes above, and the extension that tells it each conversation's directory. */
export function bridgeProvider(bridge: Bridge) {
	const controllers = new Map<string, AbortController>();
	/** Sessions whose last stream ended on tool calls, so the bridge holds their query open for the results. */
	const parked = new Set<string>();
	const heads = new Map<string, string>();
	/** Each session's directory, by the provider session id Pi Durable passes; filled in before every request. */
	const cwds = new Map<string, string>();

	const rewritten = (sessionId: string) => {
		const ctx = { sessionManager: { getSessionId: () => sessionId } };
		for (const handler of bridge.handlers.get("session_compact") ?? []) handler({ type: "session_compact", reason: "aludra", willRetry: false }, ctx);
	};

	const streamSimple: StreamFn = (model, context, options = {}) => {
		const key = options.sessionId ?? "default";
		// One-off summaries (compaction) run in their own Claude Code process and leave the session alone.
		if (options.cacheRetention !== "none") {
			const head = headOf(context);
			const before = heads.get(key);
			if (head !== undefined) heads.set(key, head);
			if (before !== undefined && head !== before) rewritten(key);
			if (context.messages.at(-1)?.role === "toolResult" && !parked.has(key)) {
				context = { ...context, messages: [...context.messages, { role: "user", content: [{ type: "text", text: RECOVERY_NOTE }], timestamp: Date.now() }] };
			}
			const prompt = bridge.systemPromptOf(context);
			if (prompt !== undefined) bridge.recordPrompt(prompt);
		}
		parked.delete(key);

		let controller = controllers.get(key);
		if (controller === undefined || controller.signal.aborted) controllers.set(key, (controller = new AbortController()));
		let running = true;
		const signal = options.signal;
		signal?.addEventListener("abort", () => running && controller.abort(signal.reason), { once: true });

		const cwd = cwds.get(key);
		const before = process.cwd();
		let stream: AssistantMessageEventStream;
		try {
			if (cwd !== undefined) process.chdir(cwd);
			stream = bridge.streamSimple(model, context, { ...options, signal: controller.signal });
		} finally {
			process.chdir(before);
		}
		stream.result().then(
			(message) => {
				running = false;
				if (message.stopReason === "toolUse" && !controller.signal.aborted) parked.add(key);
			},
			() => (running = false),
		);
		return stream;
	};

	const provider: Provider = {
		id: PROVIDER,
		name: "Claude Code (pi-claude-bridge)",
		auth: { apiKey: { name: "Claude Code login", resolve: async () => ({ auth: {} }) } },
		getModels: () => bridge.models.map((m) => ({ ...m, provider: PROVIDER, api: PROVIDER, baseUrl: PROVIDER })),
		// SAFETY: Pi Durable only asks for simple options, and the bridge reads no provider-specific ones.
		stream: (model, context, options) => streamSimple(model, context, options as SimpleStreamOptions),
		streamSimple,
	};

	const extension = defineExtension({
		name: "bridge",
		hooks: [
			hook(GenerationTask, {
				beforeRequest: async (_request, api, context) => {
					const session = await api.snapshot(ProviderDoc, api.conversationId, context);
					const agent = await api.snapshot(AgentDoc, api.conversationId, context);
					if (session !== undefined && agent?.cwd !== undefined) cwds.set(session.sessionId, agent.cwd);
					return undefined;
				},
			}),
		],
	});

	/** Ends the session's Claude Code query, if it has one. Stopping a run between requests needs this; the run's own abort only reaches a running stream. */
	function abort(sessionId: string) {
		parked.delete(sessionId);
		controllers.get(sessionId)?.abort(new Error("stopped"));
	}

	return { provider, extension, abort };
}
