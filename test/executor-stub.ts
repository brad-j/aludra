// A stand-in for hosted Executor on 127.0.0.1, for tests (from Pi Desktop's pi-host): OAuth
// discovery, dynamic client registration, an authorize endpoint that approves
// at once (as if the user clicked Allow), PKCE-checked tokens with refresh,
// and a Streamable HTTP MCP endpoint with Executor's tool names. `call` with
// path `gmail.send` answers approval-required with an approval link, like
// Executor's browser approval mode.

import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface ExecutorStub {
	/** The MCP endpoint with browser approvals, for ALUDRA_EXECUTOR_URL. */
	url: string;
	origin: string;
	/** JSON-RPC methods and tool calls the endpoint received. */
	calls: { method: string; params?: unknown }[];
	/** Every access token handed out stops working, so the next request has to refresh. */
	expireTokens(): void;
	/** Refresh tokens stop working too: the next 401 needs a new sign-in. */
	revoke(): void;
	close(): Promise<void>;
}

const TOOLS = [
	{ name: "skills", description: "Read Executor skills.", inputSchema: { type: "object", properties: { app: { type: "string" }, name: { type: "string" } } }, annotations: { readOnlyHint: true } },
	{ name: "search", description: "Find Executor app tools.", inputSchema: { type: "object", properties: { query: { type: "string" } } }, annotations: { readOnlyHint: true } },
	{ name: "describe", description: "Describe tools.", inputSchema: { type: "object", properties: { paths: { type: "array", items: { type: "string" } } }, required: ["paths"] }, annotations: { readOnlyHint: true } },
	{
		name: "call",
		description: "Call Executor app tools directly by exact path from search.",
		inputSchema: {
			type: "object",
			properties: { calls: { anyOf: [{ $ref: "#/$defs/call" }, { type: "array", items: { $ref: "#/$defs/call" } }] } },
			required: ["calls"],
			$defs: { call: { type: "object", properties: { path: { type: "string" }, input: {} }, required: ["path"] } },
		},
	},
	{ name: "execute", description: "Run a JavaScript program over Executor apps.", inputSchema: { type: "object", properties: { code: { type: "string" } }, required: ["code"] } },
	{ name: "resume", description: "Collect the answer submitted through approvalUrl.", inputSchema: { type: "object", properties: { requestId: { type: "string" } }, required: ["requestId"] } },
];

const INSTRUCTIONS = "Stand-in Executor. Search first, then call.";

function body(req: IncomingMessage): Promise<string> {
	return new Promise((resolve) => {
		let text = "";
		req.on("data", (d) => (text += d));
		req.on("end", () => resolve(text));
	});
}

const json = (res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) => {
	res.writeHead(status, { "content-type": "application/json", ...headers });
	res.end(JSON.stringify(value));
};

export async function startExecutorStub(port = 0): Promise<ExecutorStub> {
	const clients = new Map<string, string[]>();
	const codes = new Map<string, { challenge: string; clientId: string; resource: string }>();
	/** Each token's resource: a grant for /mcp (model approvals) doesn't open /mcp?elicitation_mode=browser. */
	const access = new Map<string, string>();
	const refresh = new Map<string, string>();
	const calls: ExecutorStub["calls"] = [];
	let origin = "";
	const token = () => randomBytes(16).toString("hex");

	const issue = (res: ServerResponse, resource: string) => {
		const a = token();
		const r = token();
		access.set(a, resource);
		refresh.set(r, resource);
		json(res, 200, { access_token: a, token_type: "Bearer", expires_in: 3600, refresh_token: r, scope: "mcp offline_access" });
	};

	const mcp = (msg: { id?: number; method: string; params?: Record<string, unknown> }) => {
		calls.push({ method: msg.method, params: msg.params });
		switch (msg.method) {
			case "initialize":
				return { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "Executor", version: "stub" }, instructions: INSTRUCTIONS };
			case "tools/list":
				return { tools: TOOLS };
			case "tools/call": {
				const name = msg.params?.name;
				const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
				if (name === "search") {
					const items = [{ path: "gmail.send", description: "Send an email." }, { path: "gmail.search", description: "Search mail." }];
					return { content: [{ type: "text", text: JSON.stringify({ items, query: args.query }) }], structuredContent: { items } };
				}
				if (name === "call") {
					const first = Array.isArray(args.calls) ? args.calls[0] : args.calls;
					const path = (first as { path?: string } | undefined)?.path;
					if (path === "gmail.send") {
						const pending = { status: "approval-required", requestId: "req_1", approvalUrl: `${origin}/approve/req_1`, summary: "Send an email to someone" };
						return { content: [{ type: "text", text: JSON.stringify(pending) }], structuredContent: pending };
					}
					const done = { status: "completed", result: { ok: true, path } };
					return { content: [{ type: "text", text: JSON.stringify(done) }], structuredContent: done };
				}
				if (name === "resume") {
					const done = { status: "completed", result: { sent: true } };
					return { content: [{ type: "text", text: JSON.stringify(done) }], structuredContent: done };
				}
				return { content: [{ type: "text", text: `${String(name)} ran` }] };
			}
			default:
				return undefined;
		}
	};

	const server = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", origin);
		const text = await body(req);
		if (req.method === "GET" && url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
			// Like Executor: the approval mode in the query names a resource of its own; none means "model".
			const mode = url.searchParams.get("elicitation_mode");
			const resource = mode && mode !== "model" ? `${origin}/mcp?elicitation_mode=${mode}` : `${origin}/mcp`;
			return json(res, 200, { resource, authorization_servers: [origin], scopes_supported: ["mcp", "offline_access"] });
		}
		if (req.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
			return json(res, 200, {
				issuer: origin,
				authorization_endpoint: `${origin}/authorize`,
				token_endpoint: `${origin}/token`,
				registration_endpoint: `${origin}/register`,
				response_types_supported: ["code"],
				grant_types_supported: ["authorization_code", "refresh_token"],
				token_endpoint_auth_methods_supported: ["none"],
				code_challenge_methods_supported: ["S256"],
			});
		}
		if (req.method === "POST" && url.pathname === "/register") {
			const meta = JSON.parse(text) as { redirect_uris: string[] };
			const id = `client_${token()}`;
			clients.set(id, meta.redirect_uris);
			return json(res, 201, { ...meta, client_id: id, token_endpoint_auth_method: "none" });
		}
		if (req.method === "GET" && url.pathname === "/authorize") {
			const clientId = url.searchParams.get("client_id") ?? "";
			const redirect = url.searchParams.get("redirect_uri") ?? "";
			if (!clients.get(clientId)?.includes(redirect)) return json(res, 400, { error: "invalid_request" });
			const code = token();
			codes.set(code, { challenge: url.searchParams.get("code_challenge") ?? "", clientId, resource: url.searchParams.get("resource") ?? `${origin}/mcp` });
			const back = new URL(redirect);
			back.searchParams.set("code", code);
			back.searchParams.set("state", url.searchParams.get("state") ?? "");
			res.writeHead(302, { location: back.href }).end();
			return;
		}
		if (req.method === "POST" && url.pathname === "/token") {
			const form = new URLSearchParams(text);
			if (form.get("grant_type") === "authorization_code") {
				const entry = codes.get(form.get("code") ?? "");
				codes.delete(form.get("code") ?? "");
				const verifier = form.get("code_verifier") ?? "";
				const challenge = createHash("sha256").update(verifier).digest("base64url");
				if (!entry || entry.challenge !== challenge || entry.clientId !== form.get("client_id")) return json(res, 400, { error: "invalid_grant" });
				return issue(res, entry.resource);
			}
			if (form.get("grant_type") === "refresh_token") {
				const r = form.get("refresh_token") ?? "";
				const resource = refresh.get(r);
				if (!resource || !refresh.delete(r)) return json(res, 400, { error: "invalid_grant" });
				return issue(res, resource);
			}
			return json(res, 400, { error: "unsupported_grant_type" });
		}
		if (url.pathname === "/mcp") {
			const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
			const resource = `${origin}/mcp${url.search}`;
			if (!bearer || access.get(bearer) !== resource) {
				res.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp${url.search}"` }).end();
				return;
			}
			if (req.method === "GET") return void res.writeHead(405).end();
			if (req.method === "DELETE") return void res.writeHead(200).end();
			const msg = JSON.parse(text) as { id?: number; method: string; params?: Record<string, unknown> };
			if (msg.id === undefined) return void res.writeHead(202).end();
			const result = mcp(msg);
			if (result === undefined) return json(res, 200, { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
			return json(res, 200, { jsonrpc: "2.0", id: msg.id, result }, { "mcp-session-id": "stub-session" });
		}
		res.writeHead(404).end();
	});
	await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return {
		url: `${origin}/mcp?elicitation_mode=browser`,
		origin,
		calls,
		expireTokens: () => access.clear(),
		revoke: () => (access.clear(), refresh.clear()),
		close: () => new Promise((r) => (server.closeAllConnections(), server.close(() => r()))),
	};
}
