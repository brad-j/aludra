// The MCP endpoint: aludra's sessions as tools for agents it didn't start, such as Claude Code or pi in a terminal on
// another machine, so work can be handed between machines. Streamable HTTP at POST /mcp, served by the same server as
// the API (src/api.ts) and reached the same way, through tailscale serve.
//
// Who gets in is the API's rule: the Tailscale-User-Login header names a login in api.users, and a request with an
// Origin is refused, since a browser always sends one and an agent's MCP client doesn't. So there's no OAuth: whoever
// the tailnet says is calling. It's stateless, a server and transport per request, which suits a host that restarts
// and clients that reconnect.
//
// Read-only unless the settings' mcp.write is true. Writing lets an agent start sessions, which run with every
// permission a session has (only git push and remote commands to approval hosts wait), so it's off by default.
import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { Item } from "./api-types.ts";
import type { Host } from "./host.ts";
import { readSummary } from "./live.ts";
import { findProject } from "./projects.ts";
import { context } from "./host.ts";
import { itemsOf } from "./transcript.ts";

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

/** An MCP server over `host`'s sessions, for one request. */
export function mcpServer(host: Host, options: { machine: string }): McpServer {
	const server = new McpServer({ name: `aludra on ${options.machine}`, version: "1.0.0" }, {
		instructions: `aludra runs coding-agent sessions on ${options.machine}, each in a project directory there. List projects and sessions, read a session's transcript, and search what was said. ${host.mcpWrite() ? "You can also start a session with a task, send one a message, and stop it; sessions run with full permissions in their project, so describe the task fully." : "This endpoint is read-only: the host's mcp.write setting is off."}`,
	});
	const readOnly = { readOnlyHint: true, openWorldHint: false };

	server.registerTool("list_projects", { description: `The projects sessions can work in on ${options.machine}: name, workspace and directory.`, annotations: readOnly }, async () =>
		answer(host.projects().map((p) => ({ name: p.name, workspace: p.workspace, dir: p.dir }))),
	);

	server.registerTool("list_sessions", {
		description: "Sessions, newest first: id, project, title, state (running, waiting, done, failed, stopped, idle) and the latest activity.",
		inputSchema: { project: z.string().optional().describe("Only this project's sessions"), includeArchived: z.boolean().optional(), limit: z.number().int().min(1).max(200).optional() },
		annotations: readOnly,
	}, async ({ project, includeArchived, limit }) => {
		const records = (await host.sessions.list()).filter((s) => (includeArchived === true || s.archived !== true) && (project === undefined || s.project === project));
		const summaries = (await Promise.all(records.map((r) => readSummary(host, r.id)))).filter((s) => s !== undefined);
		summaries.sort((a, b) => b.updatedAt - a.updatedAt);
		return answer(summaries.slice(0, limit ?? 30).map((s) => ({ id: s.id, project: s.project, title: s.title, state: s.state, line: s.line, updated: new Date(s.updatedAt).toISOString(), ...(s.archived === true ? { archived: true } : {}) })));
	});

	server.registerTool("read_session", {
		description: "A session's state and transcript as text: messages, answers and each tool call on a line, latest kept when it's long.",
		inputSchema: { id: z.number().int() },
		annotations: readOnly,
	}, async ({ id }) => {
		const summary = await readSummary(host, id);
		if (summary === undefined) return failure(`No session ${id}; list_sessions lists them`);
		const state = await (await host.conversation(id)).viewState(context);
		try {
			const header = `Session ${id}: ${summary.title}\nProject: ${summary.project} (${summary.dir})\nState: ${summary.state}\n\n`;
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

	if (host.mcpWrite()) {
		server.registerTool("start_session", {
			description: `Start a session in a project on ${options.machine} with a task. It runs on its own with full permissions in the project; read_session shows how it goes. Returns its id.`,
			inputSchema: { project: z.string().describe("A name from list_projects"), task: z.string().min(1).describe("Everything the agent needs to know; it can't see your conversation") },
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		}, async ({ project, task }) => {
			let found;
			try {
				found = findProject(host.projects(), project);
			} catch (error) {
				return failure(error instanceof Error ? error.message : String(error));
			}
			const session = await host.sessions.create(found, task.split("\n")[0]!.slice(0, 80));
			await host.submit(session.id, task);
			return answer({ id: session.id, project: session.project, dir: session.dir });
		});

		server.registerTool("send_message", {
			description: "Send a session a message. While it runs, it goes in at the next tool boundary (steer) or waits until the run answers (followUp, the default).",
			inputSchema: { id: z.number().int(), text: z.string().min(1), mode: z.enum(["followUp", "steer"]).optional() },
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		}, async ({ id, text, mode }) => {
			if ((await host.sessions.get(id)) === undefined) return failure(`No session ${id}`);
			const submission = await host.submit(id, text, { steer: mode === "steer" });
			return answer({ submission: Number(submission.id) });
		});

		server.registerTool("stop_session", {
			description: "Stop a session's run. Queued messages are dropped.",
			inputSchema: { id: z.number().int() },
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		}, async ({ id }) => {
			if ((await host.sessions.get(id)) === undefined) return failure(`No session ${id}`);
			await host.stop(id);
			return answer(`stopped session ${id}`);
		});
	}
	return server;
}

/** Handles one request to /mcp: a fresh server and transport each time, the JSON body read already. */
export async function handleMcp(host: Host, request: IncomingMessage, response: ServerResponse, body: unknown, options: { machine: string }): Promise<void> {
	const server = mcpServer(host, options);
	const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
	response.on("close", () => {
		void transport.close();
		void server.close();
	});
	await server.connect(transport);
	await transport.handleRequest(request, response, body);
}
