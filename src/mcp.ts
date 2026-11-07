// The MCP endpoint: aludra's sessions as tools for agents it didn't start, such as Claude Code or pi in a terminal on
// another machine, so work can be handed between machines. Streamable HTTP at POST /mcp, served by the same server as
// the API (src/api.ts) and reached the same way, through tailscale serve.
//
// Who gets in: a bearer token made with `aludra token add` (src/tokens.ts), one per agent, and a request with an Origin
// is refused, since a browser always sends one and an agent's MCP client doesn't. Not the API's Tailscale login: a
// tagged machine has none, and it names a person rather than the agent. There's no OAuth. It's stateless, a server and
// transport per request, which suits a host that restarts and clients that reconnect.
//
// Read-only unless the token's scope is write and the settings' mcp.write is true. Writing lets an agent start
// sessions, which run with every permission a session has (only git push and remote commands to approval hosts wait),
// so tokens are read-only and mcp.write is off by default; mcp.write turns writing off for every token at once.
//
// mcp.sandboxOnly narrows writing to sandboxes: start_session makes only sandbox sessions, refusing a call that asks for
// a local one rather than quietly giving it a sandbox, and send_message and stop_session refuse any session that isn't
// in one, whoever started it. Without a sandbox host every write tool refuses, so nothing falls back to a local
// session. No tool here syncs, merges, ships or archives; what a run's end does to the checkout is sandboxes.afterRun's.
//
// check_sessions and mark_sessions_handled are a gate for an agent that wakes on sessions changing without a model
// running (Lan's): check_sessions answers { wake, data, topic } and moves nothing, mark_sessions_handled moves the
// calling token's cursor (src/session-changes.ts). Both are reading tools, since a cursor is only that token's.
import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { Item } from "./api-types.ts";
import type { Host } from "./host.ts";
import type { Thinking } from "./config.ts";
import type { Scope, Token } from "./tokens.ts";
import { prose, parseSaid } from "./results.ts";
import { readSummary } from "./live.ts";
import { findProject } from "./projects.ts";
import { context, isSandboxSession } from "./host.ts";
import { itemsOf } from "./transcript.ts";

const THINKING_LIST = "off, minimal, low, medium, high, xhigh";

/** Longest text a tool answers with; transcripts keep their latest items within it. */
const MAX_TEXT = 60_000;

type Answer = { content: { type: "text"; text: string }[]; isError?: boolean };
const answer = (value: unknown): Answer => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });
const failure = (message: string): Answer => ({ content: [{ type: "text", text: message }], isError: true });

/** A transcript as plain text: who said what, and each call on a line. */
export function transcriptText(items: readonly Item[], limit = MAX_TEXT): string {
	const lines = items.map((item) => {
		switch (item.kind) {
			case "user":
				return `## User\n${item.text}`;
			case "answer":
				return `## Agent\n${item.text}`;
			case "call": {
				const arg = typeof item.args.command === "string" ? item.args.command : typeof item.args.path === "string" ? item.args.path : JSON.stringify(item.args).slice(0, 200);
				return `- ${item.tool} ${arg} (${item.status})`;
			}
			case "failure":
				return `## Failed (${item.type})\n${item.message}`;
			case "compacted":
				return "(earlier messages summarized)";
		}
	});
	const kept: string[] = [];
	let used = 0;
	for (let i = lines.length - 1; i >= 0; i--) {
		if (used + lines[i]!.length > limit) {
			kept.unshift(`(${i + 1} earlier items left out)`);
			break;
		}
		kept.unshift(lines[i]!);
		used += lines[i]!.length + 1;
	}
	return kept.join("\n\n");
}

/** Why a token of `scope` can't write on `host`, or undefined when it can. */
export function writeRefusal(host: Host, scope: Scope): string | undefined {
	if (scope !== "write") return "this token is read-only";
	if (!host.mcpWrite()) return "the host's mcp.write setting is off";
	return undefined;
}

/** Why, under mcp.sandboxOnly, no write tool can act at all: there's no sandbox host. Undefined when they can. */
export function sandboxOnlyRefusal(host: Host): string | undefined {
	if (!host.mcpSandboxOnly()) return undefined;
	if (host.sandboxSettings() === undefined) return "mcp.sandboxOnly is on but the settings name no sandbox host (sandboxes), so no session can be started or changed over MCP";
	return undefined;
}

/** The last non-empty line of an answer's prose, without Markdown's marks, cut to 300 characters. */
function lastLine(text: string): string {
	const line = prose(text).split("\n").map((l) => l.trim()).filter((l) => l !== "" && !/^(`{3,}|~{3,})/.test(l)).at(-1) ?? "";
	const plain = line.replace(/[*_`#>]/g, "").trim();
	return plain.length > 300 ? `${plain.slice(0, 299)}…` : plain;
}

/**
 * The model and effort session `view` runs its next turn on, as start_session and send_message take them: a pinned
 * model's ID, else provider/id, and its thinking level; the host's defaults where the session names none.
 */
export function agentOf(host: Host, view: { docs: Record<string, unknown> }): { ref: { provider: string; modelId: string }; model: string; effort: Thinking } {
	// SAFETY: a document in the view is the JSON of its kind's state.
	const agent = view.docs["pi.agent"] as { model?: { provider: string; modelId: string }; thinkingLevel?: Thinking } | undefined;
	const ref = agent?.model ?? host.model;
	const pinned = host.choices().some((c) => c.provider === ref.provider && c.id === ref.modelId);
	return { ref, model: pinned ? ref.modelId : `${ref.provider}/${ref.modelId}`, effort: agent?.thinkingLevel ?? host.thinking };
}

/** Session `id`'s model and effort, as agentOf gives them. */
async function sessionAgent(host: Host, id: number) {
	const state = await (await host.conversation(id)).viewState(context);
	try {
		return agentOf(host, state.value);
	} finally {
		state.dispose();
	}
}

/** What check_sessions tells a gate: whether to wake, an entry per changed session, and the newest change in a line. */
export async function checkSessions(host: Host, token: Pick<Token, "id" | "createdAt">) {
	const records = await host.sessions.list();
	const summaries = new Map((await Promise.all(records.map((r) => readSummary(host, r.id)))).filter((s) => s !== undefined).map((s) => [s.id, s]));
	host.sessionChanges.observe([...summaries.values()].map((s) => ({ id: s.id, state: s.state, updatedAt: s.updatedAt })));
	// One entry per session: from the state before its first unhandled change to its latest.
	const bySession = new Map<number, { change: number; from: string | null; to: string }>();
	for (const c of host.sessionChanges.pending(token.id, token.createdAt.getTime())) {
		const before = bySession.get(c.session);
		bySession.set(c.session, { change: c.change, from: before === undefined ? c.from : before.from, to: c.to });
	}
	const data = [];
	for (const [id, c] of bySession) {
		const summary = summaries.get(id);
		if (summary === undefined) continue;
		const state = await (await host.conversation(id)).viewState(context);
		let agent = "";
		let question: { text: string; options: string[] } | undefined;
		let settings: ReturnType<typeof agentOf>;
		try {
			settings = agentOf(host, state.value);
			const answer = itemsOf(state.value).findLast((item) => item.kind === "answer" && item.streaming !== true);
			if (answer?.kind === "answer") {
				agent = lastLine(answer.text);
				const asked = parseSaid(answer.text).question;
				if (asked !== undefined) question = { text: asked.text, options: asked.options ?? [] };
			}
		} finally {
			state.dispose();
		}
		data.push({
			change: c.change,
			id,
			project: summary.project,
			title: summary.title,
			from: c.from,
			to: c.to,
			transition: `${c.from ?? "new"} → ${c.to}`,
			state: summary.state,
			updated: new Date(summary.updatedAt).toISOString(),
			line: summary.line,
			model: settings.model,
			effort: settings.effort,
			agent,
			...(question === undefined ? {} : { question }),
			...(summary.sandbox === undefined ? {} : { sandbox: summary.sandbox }),
			...(summary.archived === true ? { archived: true } : {}),
		});
	}
	data.sort((a, b) => a.change - b.change);
	const newest = data.at(-1);
	const topic = newest === undefined ? "" : `${newest.project} #${newest.id} ${newest.title}: ${newest.transition}${data.length > 1 ? ` (+${data.length - 1} more)` : ""}`;
	return { wake: data.length > 0, data, topic, ...(newest === undefined ? {} : { through: newest.change }) };
}

/**
 * The model and thinking a turn asks for, checked against what the session can run: a model a session can be started
 * with (a pinned ID, or provider/id), and a thinking level that model takes. `current` is the model the session has
 * now, which the effort is checked against when no model is given. A string is the reason it's refused.
 */
export function turnSettings(host: Host, asked: { model?: string | undefined; effort?: string | undefined }, current: { provider: string; modelId: string }): { model?: string; thinking?: Thinking } | string {
	let ref = current;
	if (asked.model !== undefined) {
		try {
			ref = host.chooseModel(asked.model)!;
		} catch {
			const pinned = host.choices().map((c) => c.id);
			return `unknown model ${asked.model}: use one of ${pinned.join(", ")}, or provider/id for another model this host has`;
		}
	}
	if (asked.effort !== undefined) {
		const levels = host.thinkingLevels(ref);
		if (!(levels as string[]).includes(asked.effort)) return `effort ${asked.effort} isn't one ${ref.provider}/${ref.modelId} takes: use one of ${levels.join(", ")}`;
	}
	return { ...(asked.model === undefined ? {} : { model: asked.model }), ...(asked.effort === undefined ? {} : { thinking: asked.effort as Thinking }) };
}

/** An MCP server over `host`'s sessions, for one request by `token`. */
export function mcpServer(host: Host, options: { machine: string; token: Pick<Token, "id" | "scope" | "createdAt"> }): McpServer {
	const refusal = writeRefusal(host, options.token.scope);
	// Fixed for the server's life, so the instructions and descriptions an agent sees don't change between calls.
	const sandboxOnly = host.mcpSandboxOnly();
	const writing = refusal !== undefined
		? `This endpoint is read-only for you: ${refusal}.`
		: sandboxOnly
			? "You can also start a session with a task, send one a message, and stop it, in sandboxes only: every session you start runs in a sandbox VM of its own, and you can message or stop only sandbox sessions. Describe the task fully."
			: "You can also start a session with a task, send one a message, and stop it; sessions run with full permissions in their project, so describe the task fully.";
	const server = new McpServer({ name: `aludra on ${options.machine}`, version: "1.0.0" }, {
		instructions: `aludra runs coding-agent sessions on ${options.machine}, each in a project directory there. List projects and sessions, read a session's transcript, and search what was said. ${writing}`,
	});
	/** Why a write tool can't act on session `id`, or undefined when it can; under sandboxOnly, only sandbox sessions. */
	const sessionRefusal = async (id: number): Promise<string | undefined> => {
		const blocked = sandboxOnlyRefusal(host);
		if (blocked !== undefined) return blocked;
		const record = await host.sessions.get(id);
		if (record === undefined) return `No session ${id}`;
		if (sandboxOnly && !isSandboxSession(record)) return `session ${id} isn't in a sandbox, and this endpoint acts only on sandbox sessions (mcp.sandboxOnly)`;
		return undefined;
	};
	const readOnly = { readOnlyHint: true, openWorldHint: false };

	server.registerTool("list_projects", { description: `The projects sessions can work in on ${options.machine}: name, workspace and directory.`, annotations: readOnly }, async () =>
		answer(host.projects().map((p) => ({ name: p.name, workspace: p.workspace, dir: p.dir }))),
	);

	server.registerTool("list_sessions", {
		description: "Sessions, newest first: id, project, title, state (running, waiting, done, failed, stopped, idle), the latest activity, and the model and effort its next turn runs on, as start_session and send_message take them.",
		inputSchema: { project: z.string().optional().describe("Only this project's sessions"), includeArchived: z.boolean().optional(), limit: z.number().int().min(1).max(200).optional() },
		annotations: readOnly,
	}, async ({ project, includeArchived, limit }) => {
		const records = (await host.sessions.list()).filter((s) => (includeArchived === true || s.archived !== true) && (project === undefined || s.project === project));
		const summaries = (await Promise.all(records.map((r) => readSummary(host, r.id)))).filter((s) => s !== undefined);
		summaries.sort((a, b) => b.updatedAt - a.updatedAt);
		const shown = summaries.slice(0, limit ?? 30);
		const agents = await Promise.all(shown.map((s) => sessionAgent(host, s.id)));
		return answer(shown.map((s, i) => ({ id: s.id, project: s.project, title: s.title, state: s.state, line: s.line, updated: new Date(s.updatedAt).toISOString(), model: agents[i]!.model, effort: agents[i]!.effort, ...(s.archived === true ? { archived: true } : {}) })));
	});

	server.registerTool("read_session", {
		description: "A session's state, the model and effort its next turn runs on, and its transcript as text: messages, answers and each tool call on a line, latest kept when it's long.",
		inputSchema: { id: z.number().int() },
		annotations: readOnly,
	}, async ({ id }) => {
		const summary = await readSummary(host, id);
		if (summary === undefined) return failure(`No session ${id}; list_sessions lists them`);
		const state = await (await host.conversation(id)).viewState(context);
		try {
			const { model, effort } = agentOf(host, state.value);
			const header = `Session ${id}: ${summary.title}\nProject: ${summary.project} (${summary.dir})\nState: ${summary.state}\nModel: ${model}\nEffort: ${effort}\n\n`;
			return answer(header + transcriptText(itemsOf(state.value)));
		} finally {
			state.dispose();
		}
	});

	server.registerTool("search_messages", {
		description: "Messages and answers containing every word, across sessions or in one, best first, with the text around each match.",
		inputSchema: { query: z.string(), session: z.number().int().optional(), limit: z.number().int().min(1).max(100).optional() },
		annotations: readOnly,
	}, async ({ query, session, limit }) => {
		const results = await host.search(query, { limit: limit ?? 20, ...(session === undefined ? {} : { session }) });
		return answer(results.map((r) => ({ session: r.session, project: r.project, title: r.title, from: r.from, at: new Date(r.at).toISOString(), snippet: r.snippet })));
	});

	server.registerTool("check_sessions", {
		description: "A gate for waking on session changes: { wake, data, topic }. wake is true when a session is new, or has come to rest (done, failed, stopped, waiting, idle) since this token last called mark_sessions_handled. data has an entry per changed session: change (its number), id, project, title, from and to states, updated, line, the agent's last line, and the question it asks with options when it asks one. topic is the newest change in a line. Moves nothing: call mark_sessions_handled with the change you've handled through.",
		annotations: readOnly,
	}, async () => answer(await checkSessions(host, options.token)));

	server.registerTool("mark_sessions_handled", {
		description: "Marks the session changes check_sessions gave up to and including change `through` handled, for this token only; other clients keep their own place. It never moves back.",
		inputSchema: { through: z.number().int().min(0).describe("A change number from check_sessions, usually the largest") },
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
	}, async ({ through }) => answer(host.sessionChanges.markHandled(options.token.id, through)));

	if (refusal === undefined) {
		const turnFields = {
			model: z.string().min(1).optional().describe(`The model for this turn and the session's turns after it: one of ${host.choices().map((c) => c.id).join(", ")}, or provider/id. Default: the session's model, or the host's default for a new session.`),
			effort: z.string().min(1).optional().describe(`Thinking effort for this turn and after it: one of ${THINKING_LIST} that the model takes. Default: the session's, or the host's default for a new session.`),
		};
		const sandboxText = "a sandbox VM of its own: a copy of the project's last commit that reaches the internet and nothing else, holding no keys. Its commits come back to the project's sandbox/N branch";
		server.registerTool("start_session", {
			description: sandboxOnly
				? `Start a session in a project on ${options.machine} with a task, sandbox-only: it always runs in ${sandboxText}. A local session is refused. read_session shows how it goes. Returns its id.`
				: `Start a session in a project on ${options.machine} with a task. It runs on its own with full permissions in the project; read_session shows how it goes. Returns its id.`,
			inputSchema: {
				project: z.string().describe("A name from list_projects"),
				task: z.string().min(1).describe("Everything the agent needs to know; it can't see your conversation"),
				sandbox: z.boolean().optional().describe(sandboxOnly
					? "Sandbox-only here: leave it out or pass true; false is refused."
					: "Run its tools in a sandbox VM of its own: a copy of the project's last commit that reaches the internet and nothing else, holding no keys. Its commits come back with `aludra sync`."),
				...turnFields,
			},
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		}, async ({ project, task, sandbox, model, effort }) => {
			const blocked = sandboxOnlyRefusal(host);
			if (blocked !== undefined) return failure(blocked);
			if (sandboxOnly && sandbox === false) return failure("this endpoint starts only sandbox sessions (mcp.sandboxOnly); leave sandbox out or pass true");
			const agent = turnSettings(host, { model, effort }, host.model);
			if (typeof agent === "string") return failure(agent);
			const inSandbox = sandboxOnly || sandbox === true;
			let found;
			try {
				found = findProject(host.projects(), project);
			} catch (error) {
				return failure(error instanceof Error ? error.message : String(error));
			}
			const title = task.split("\n")[0]!.slice(0, 80);
			let session;
			try {
				session = inSandbox ? await host.sessions.createSandbox(found, title, agent) : await host.sessions.create(found, title, agent);
			} catch (error) {
				return failure(error instanceof Error ? error.message : String(error));
			}
			await host.submit(session.id, task);
			return answer({ id: session.id, project: session.project, dir: session.dir, ...(session.sandbox === undefined ? {} : { sandbox: session.sandbox }) });
		});

		server.registerTool("send_message", {
			description: `Send a session a message. While it runs, it goes in at the next tool boundary (steer) or waits until the run answers (followUp, the default).${sandboxOnly ? " Sandbox-only: a session that isn't in a sandbox is refused." : ""}`,
			inputSchema: { id: z.number().int(), text: z.string().min(1), mode: z.enum(["followUp", "steer"]).optional(), ...turnFields },
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		}, async ({ id, text, mode, model, effort }) => {
			const refused = await sessionRefusal(id);
			if (refused !== undefined) return failure(refused);
			try {
				if (model !== undefined || effort !== undefined) {
					const agent = turnSettings(host, { model, effort }, (await sessionAgent(host, id)).ref);
					if (typeof agent === "string") return failure(agent);
					// Set before the message goes in, so it's the turn's from its first request. A run going on would take them
					// at its next request, so they wait for one that has ended.
					if ((await host.sessions.states()).get(id) !== "idle") return failure(`session ${id} is running; send model or effort once its run has ended, or leave them out`);
					await host.configure(id, agent);
				}
				const submission = await host.submit(id, text, { steer: mode === "steer" });
				return answer({ submission: Number(submission.id) });
			} catch (error) {
				return failure(error instanceof Error ? error.message : String(error));
			}
		});

		server.registerTool("stop_session", {
			description: `Stop a session's run. Queued messages are dropped.${sandboxOnly ? " Sandbox-only: a session that isn't in a sandbox is refused." : ""}`,
			inputSchema: { id: z.number().int() },
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		}, async ({ id }) => {
			const refused = await sessionRefusal(id);
			if (refused !== undefined) return failure(refused);
			await host.stop(id);
			return answer(`stopped session ${id}`);
		});
	}
	return server;
}

/** Handles one request to /mcp: a fresh server and transport each time, the JSON body read already. */
export async function handleMcp(host: Host, request: IncomingMessage, response: ServerResponse, body: unknown, options: { machine: string; token: Token }): Promise<void> {
	const server = mcpServer(host, options);
	const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
	response.on("close", () => {
		void transport.close();
		void server.close();
	});
	await server.connect(transport);
	await transport.handleRequest(request, response, body);
}
