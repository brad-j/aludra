// The Claude provider: @earendil-works/pi-claude-code, which runs the user's own Claude Code (`claude -p`) on their own
// login as the model and nothing more. Pi Durable keeps the history, compacts it and runs the tools: each turn the
// provider hands Claude Code the transcript, and Claude Code returns the model's answer and tool calls without running
// any. A turn that can't continue its session's warm Claude Code process (after a tool call, a restart, a compaction or
// a reset) starts a fresh one that replays the transcript, so none of those need glue here.
//
// It ships TypeScript, which Node won't strip inside node_modules, so its provider module loads through jiti, with its
// imports of pi-ai pointed at the copy Pi Durable uses. Its extension entry point isn't loaded; it only adds pi a command.
// claudeCodeProvider wraps the provider for Pi Durable:
//
// - The working directory. Claude Code tells the model its process's directory, and the provider reads process.cwd()
//   synchronously when a request starts, so the wrapper changes into the conversation's directory around the call.
// - The ID. Its models run under aludra's provider ID, claude-bridge, which sessions and settings already name.
// - The catalog. Its built-in list trails Claude Code's. `refresh` asks Claude Code what the account offers (no model
//   call), and the list is then only those, less Claude Code's `default` alias for one of them.
//
// The provider runs the Claude Code that `claude.path` names (PI_CLAUDE_CODE_COMMAND, set before it loads) with the
// host's environment, so CLAUDE_CONFIG_DIR picks the login. It refuses to start Claude Code when that environment names
// an API key or another backend, and fails a turn that was charged to usage credits rather than the plan.
//
// It's pinned to a commit; upgrade it deliberately and rerun scripts/live-check.ts.
import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, AssistantMessageEventStream, Model, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai/models";
import { AgentDoc, defineExtension, GenerationTask, hook, ProviderDoc } from "@earendil-works/pi-durable";

export const PROVIDER = "claude-bridge";

const resolveFile = (specifier: string) => fileURLToPath(import.meta.resolve(specifier));

/** `path` as an executable file: as it is if it has a slash, else the first match on PATH. */
export function findExecutable(path: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
	const candidates = path.includes("/") ? [resolve(path)] : (env.PATH ?? "").split(delimiter).filter((d) => isAbsolute(d)).map((d) => join(d, path));
	return candidates.find((file) => {
		try {
			accessSync(file, constants.X_OK);
			return true;
		} catch {
			return false;
		}
	});
}

/** The Claude Code binary `claudePath` names, or an error that says how to get one. */
export function claudeExecutable(claudePath: string): string {
	const found = findExecutable(claudePath);
	if (found !== undefined) return found;
	throw new Error(claudePath.includes("/")
		? `no Claude Code at ${claudePath} (claude.path in the settings)`
		: `no ${claudePath} on PATH: install Claude Code and run claude auth login, or set claude.path in the settings to where it is`);
}

// The provider keeps its warm Claude Code processes at module level, so it's loaded once per process.
let loading: Promise<Provider> | undefined;

/** pi-claude-code's provider, running the Claude Code `claudePath` names. It loads once per process, with the first caller's path. */
export function loadClaudeCode(claudePath: string): Promise<Provider> {
	loading ??= load(claudePath);
	return loading;
}

async function load(claudePath: string): Promise<Provider> {
	process.env.PI_CLAUDE_CODE_COMMAND = claudeExecutable(claudePath);
	const { createJiti } = await import("jiti");
	const jiti = createJiti(import.meta.url, {
		alias: {
			"@earendil-works/pi-ai/providers/all": resolveFile("@earendil-works/pi-ai/providers/all"),
			"@earendil-works/pi-ai": resolveFile("@earendil-works/pi-ai"),
		},
	});
	const src = join(resolveFile("@earendil-works/pi-claude-code/package.json"), "..", "src");
	const { createClaudeCodeProvider } = await jiti.import<{ createClaudeCodeProvider(): Provider }>(join(src, "provider.ts"));
	return createClaudeCodeProvider();
}

type StreamFn = (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) => AssistantMessageEventStream;

/** pi-claude-code's provider for Pi Durable, with the changes above, and the extension that tells it each conversation's directory. */
export function claudeCodeProvider(inner: Provider) {
	/** Each session's directory, by the provider session id Pi Durable passes; filled in before every request. */
	const cwds = new Map<string, string>();

	const streamSimple: StreamFn = (model, context, options) => {
		const cwd = options?.sessionId === undefined ? undefined : cwds.get(options.sessionId);
		const before = process.cwd();
		try {
			if (cwd !== undefined) process.chdir(cwd);
			return inner.streamSimple(model, context, options);
		} finally {
			process.chdir(before);
		}
	};

	const provider: Provider = {
		id: PROVIDER,
		name: "Claude Code",
		auth: inner.auth,
		getModels: () => (inner.filterModels?.(inner.getModels(), undefined) ?? inner.getModels())
			.filter((m) => m.id !== "default")
			.map((m) => ({ ...m, provider: PROVIDER, api: PROVIDER, baseUrl: PROVIDER })),
		refreshModels: async (context) => inner.refreshModels?.(context),
		// SAFETY: Pi Durable only asks for simple options, and the provider reads no provider-specific ones.
		stream: (model, context, options) => streamSimple(model, context, options as SimpleStreamOptions),
		streamSimple,
	};

	const extension = defineExtension({
		name: "claude-code",
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

	return { provider, extension };
}
