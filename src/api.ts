// The HTTP API: loopback HTTP for actions and a WebSocket for everything live; there's no web app. tailscale serve puts
// HTTPS in front and adds Tailscale-User-Login; only the logins in `users` get in (after gaidin's).
//
//   GET  /api/bootstrap                   projects, models, thinking levels, defaults
//   POST /api/sessions                    { project, text, images?, model?, thinking? } → { id }
//   POST /api/sessions/:id/messages       { text, images?, mode: "steer" | "followUp" }
//   GET  /api/sessions/:id/images/:entry/:message/:block   an image in the transcript (src/images.ts)
//   POST /api/sessions/:id/stop
//   POST /api/sessions/:id/title          { title }
//   POST /api/sessions/:id/archive        { archived }                                   hides it from the lists, or brings it back
//   POST /api/sessions/:id/agent          { model?, thinking? }
//   POST /api/sessions/:id/withdraw       { submission }
//   GET  /api/sessions/:id/changes        what the session changed since it started (src/changes.ts)
//   GET  /api/sessions/:id/changes/diff?path=   one changed file's diff
//   POST /api/approvals/:id               { allow }
//   POST /api/ideas                       { project, text }                            → { id }
//   POST /api/ideas/:id/start                                                          → { id } of the session
//   POST /api/ideas/:id/delete
//   POST /api/projects/color              { project, color: 0-10 | null }                 a picked color, or the hashed one again
//   GET  /api/settings                    every setting, described for a form (Settings in src/api-types.ts)
//   POST /api/settings                    { changes: { key: value | null } } → Settings     saved, and applied where it can be
//   GET  /api/push                        the key devices sign up with, and the devices
//   POST /api/push/subscribe              { endpoint, keys: { p256dh, auth }, label }
//   POST /api/push/unsubscribe            { endpoint }
//   POST /api/push/test
//   WS   /api/live                        ServerEvent out, ClientEvent in (src/api-types.ts)
//
//   WS   /amyrlin                         the amyrlin Mac app's protocol (src/amyrlin/endpoint.ts)
//
// Anything else is a 404. Notifications (src/push.ts) go out when a call waits for approval and when a run ends done or
// failed, except for a session a client on /api/live says it's showing on screen.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { hostname } from "node:os";
import { WebSocketServer, type WebSocket } from "ws";
import { createAmyrlinEndpoint } from "./amyrlin/endpoint.ts";
import type { Bootstrap, ClientEvent, PushState, ServerEvent, Thinking } from "./api-types.ts";
import { THINKING } from "./config.ts";
import { IMAGE_TYPES, messageContent, titleOf } from "./images.ts";
import type { Host } from "./host.ts";
import { array, boolean, integer, jsonObject, literal, nullable, object, optional, ParseError, parseJson, string } from "./parse.ts";
import { findProject } from "./projects.ts";
import type { ApprovalRequest } from "./permissions.ts";
import type { Push, PushMessage } from "./push.ts";
import { createLive, type Live } from "./live.ts";
import { changesSince, fileDiff } from "./changes.ts";

class HttpError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

/**
 * On every response. Nothing here is a page: another site can't frame an answer, which would carry the user's tailnet
 * identity, and a browser runs no script from one.
 */
const SECURITY_HEADERS = {
	"Content-Security-Policy": "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
	"X-Frame-Options": "DENY",
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
};

/**
 * Another site open in the user's browser could post here with their tailnet identity. A JSON body forces a CORS preflight,
 * which gets no CORS headers back, and the Origin has to be this host.
 */
function sameOrigin(request: IncomingMessage, json: boolean): boolean {
	if (json && !request.headers["content-type"]?.startsWith("application/json")) return false;
	const origin = request.headers.origin;
	return origin === undefined || origin === `https://${request.headers.host}` || origin === `http://${request.headers.host}`;
}

/** Messages carry images, so their posts may be large; anything else is small. */
const bodyLimit = (path: string) => (path === "/api/sessions" || /^\/api\/sessions\/\d+\/messages$/.test(path) ? 64 * 1024 * 1024 : 200_000);

async function readBody(request: IncomingMessage, limit: number): Promise<string> {
	let text = "";
	for await (const chunk of request) {
		text += chunk;
		if (text.length > limit) throw new HttpError(413, "Too large");
	}
	return text;
}

const thinking = literal<Thinking>(...THINKING);
const image = object({ mimeType: string, data: string });
const newSession = object({ project: string, text: string, images: optional(array(image)), model: optional(string), thinking: optional(thinking), requestId: optional(string) });
const message = object({ text: string, images: optional(array(image)), mode: literal("steer", "followUp"), requestId: optional(string) });
const agentChange = object({ model: optional(string), thinking: optional(thinking) });
const withdrawal = object({ submission: integer });
const newTitle = object({ title: string });
const archiving = object({ archived: boolean });
const decision = object({ allow: boolean });
const clientEvent = object({ type: literal("follow", "visible"), session: optional(integer), visible: optional(boolean) });
const newIdea = object({ project: string, text: string });
const projectColor = object({ project: string, color: nullable(integer) });
const subscription = object({ endpoint: string, keys: object({ p256dh: string, auth: string }), label: optional(string) });
const endpointBody = object({ endpoint: string });
const settingsChange = object({ changes: jsonObject });

export type ApiOptions = {
	/** The live feed to share; one of its own otherwise. */
	live?: Live;
	/** The Tailscale logins let in. */
	users: readonly string[];
	/** Notifications to devices; without it, none are sent. */
	push?: Push;
	/** The host's name in the apps. Default: this machine's name. */
	name?: string;
};

export function createApi(host: Host, options: ApiOptions) {
	const { push } = options;
	/** What each open socket follows, and whether its app is on screen. */
	const watchers = new Map<WebSocket, { session: number | null; visible: boolean }>();
	const onScreen = (id: number) => [...watchers.values()].some((w) => w.session === id && w.visible);

	function notify(id: number, message: PushMessage) {
		if (push === undefined || onScreen(id)) return;
		push.send(message).catch((error) => console.error("[push]", error instanceof Error ? error.message : error));
	}

	// The live feed is the server's when it shares one with the CLI's socket; a test's API makes its own.
	const live = options.live ?? createLive(host);
	const stopRunEnd = live.onRunEnd((after) => {
		const url = `/s/${after.id}`;
		if (after.state === "done") notify(after.id, { title: `Done · ${after.project}`, body: `${after.title}\n${after.line}`, tag: `session-${after.id}`, url });
		if (after.state === "failed") notify(after.id, { title: `Failed · ${after.project}`, body: `${after.title}\n${after.line}`, tag: `session-${after.id}`, url, urgency: "high" });
	});
	// An approval is pushed after a moment, if it still waits: the app may be about to show it, or the user may answer it at once.
	const APPROVAL_DELAY_MS = 2000;
	const timers = new Set<NodeJS.Timeout>();
	const TEST_DELAY_MS = 5000;
	const stopApprovals = host.approvals.onChange((request: ApprovalRequest) => {
		if (request.status !== "pending") return;
		const timer = setTimeout(() => void pushApproval(request).catch((error) => console.error("[push]", error)).finally(() => timers.delete(timer)), APPROVAL_DELAY_MS);
		timers.add(timer);
	});
	async function pushApproval(request: ApprovalRequest) {
		if (!(await host.approvals.pending()).some((r) => r.id === request.id)) return;
		const session = await host.sessions.get(request.conversationId);
		notify(request.conversationId, {
			title: `Waiting for you · ${session?.project ?? "aludra"}`,
			body: `Wants to run ${request.summary}: ${request.command}\n${session?.title ?? ""}`,
			tag: `approval-${request.id}`,
			url: `/s/${request.conversationId}`,
			urgency: "high",
		});
	}


	function reply(response: ServerResponse, status: number, body: string | Buffer, type: string, cache = "no-store") {
		response.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": type, "Cache-Control": cache });
		response.end(body);
	}
	const json = (response: ServerResponse, value: unknown) => reply(response, 200, JSON.stringify(value), "application/json");

	async function bootstrap(login: string): Promise<Bootstrap> {
		const choices = host.choices();
		const model = choices.find((c) => c.id === host.model.modelId) ?? { provider: host.model.provider, id: host.model.modelId, name: host.model.modelId };
		return {
			user: login,
			machine: options.name ?? hostname(),
			projects: host.projects().map(({ workspace, name, path, dir }) => ({ workspace, name, path, dir })),
			models: choices,
			catalog: await host.catalog(),
			thinking: [...THINKING],
			defaults: { model, thinking: host.thinking },
		};
	}

	async function pushState(): Promise<PushState> {
		if (push === undefined) throw new HttpError(404, "Notifications are off");
		return { publicKey: push.publicKey, devices: (await push.devices()).map(({ endpoint, label, addedAt }) => ({ endpoint, label, addedAt })) };
	}

	async function post(path: string, body: string, origin: string): Promise<unknown> {
		if (path === "/api/settings") return host.settings.set(parseJson(body, settingsChange, "the settings").changes);
		if (path === "/api/projects/color") {
			const request = parseJson(body, projectColor, "the color");
			return { colors: await host.colors.set(request.project, request.color ?? null) };
		}
		if (path === "/api/ideas") {
			const request = parseJson(body, newIdea, "the idea");
			if (request.text.trim() === "") throw new HttpError(400, "Say what the idea is");
			return { id: (await host.ideas.add(findProject(host.projects(), request.project), request.text)).id };
		}
		const idea = /^\/api\/ideas\/(\d+)\/(start|delete)$/.exec(path);
		if (idea !== null) {
			const id = Number(idea[1]);
			if (idea[2] === "start") return { id: (await host.ideas.start(id)).id };
			if ((await host.ideas.remove(id)) === undefined) throw new HttpError(404, `No idea ${id}`);
			return {};
		}
		if (path.startsWith("/api/push/")) {
			if (push === undefined) throw new HttpError(404, "Notifications are off");
			if (path === "/api/push/subscribe") {
				const request = parseJson(body, subscription, "the subscription");
				try {
					await push.add({ endpoint: request.endpoint, p256dh: request.keys.p256dh, auth: request.keys.auth, label: request.label ?? "a device", origin });
				} catch (error) {
					throw new HttpError(400, error instanceof Error ? error.message : String(error));
				}
				return pushState();
			}
			if (path === "/api/push/unsubscribe") {
				await push.remove(parseJson(body, endpointBody, "the device").endpoint);
				return pushState();
			}
			if (path === "/api/push/test") {
				// After a moment, so the phone can be locked first: iOS shows no banner for the web app on screen.
				const timer = setTimeout(() => {
					timers.delete(timer);
					push.send({ title: "aludra", body: "Notifications work on this device.", tag: "test" }).catch((error) => console.error("[push]", error instanceof Error ? error.message : error));
				}, TEST_DELAY_MS);
				timers.add(timer);
				return { devices: (await push.devices()).length, inSeconds: TEST_DELAY_MS / 1000 };
			}
			throw new HttpError(404, "Not found");
		}
		if (path === "/api/sessions") {
			const request = parseJson(body, newSession, "the new session");
			if (request.text.trim() === "" && (request.images ?? []).length === 0) throw new HttpError(400, "Say what the session should do");
			const content = messageContent(request.text, request.images);
			const agent = { ...(request.model === undefined ? {} : { model: request.model }), ...(request.thinking === undefined ? {} : { thinking: request.thinking }) };
			const title = titleOf(request.text, request.images);
			// An empty project is a no-project session, in a scratch directory of its own.
			const session = request.project === "" ? await host.sessions.createScratch(title, agent) : await host.sessions.create(findProject(host.projects(), request.project), title, agent);
			await host.submit(session.id, content, request.requestId === undefined ? {} : { requestId: request.requestId });
			return { id: session.id };
		}
		const approval = /^\/api\/approvals\/([\w-]+)$/.exec(path);
		if (approval !== null) {
			const decided = await host.approvals.decide(approval[1]!, parseJson(body, decision, "the decision").allow);
			if (decided === undefined) throw new HttpError(409, "That approval isn't waiting any more");
			return { status: decided.status };
		}
		const match = /^\/api\/sessions\/(\d+)\/(messages|stop|agent|withdraw|title|archive)$/.exec(path);
		if (match === null) throw new HttpError(404, "Not found");
		const id = Number(match[1]);
		if ((await host.sessions.get(id)) === undefined) throw new HttpError(404, `No session ${id}`);
		switch (match[2]) {
			case "messages": {
				const request = parseJson(body, message, "the message");
				if (request.text.trim() === "" && (request.images ?? []).length === 0) throw new HttpError(400, "The message is empty");
				const submission = await host.submit(id, messageContent(request.text, request.images), { steer: request.mode === "steer", ...(request.requestId === undefined ? {} : { requestId: request.requestId }) });
				return { submission: Number(submission.id) };
			}
			case "stop":
				await host.stop(id);
				return {};
			case "agent":
				await host.configure(id, parseJson(body, agentChange, "the change"));
				live.touch(id);
				return {};
			case "title":
				return { title: (await host.sessions.rename(id, parseJson(body, newTitle, "the title").title)).title };
			case "archive":
				return { archived: (await host.sessions.archive(id, parseJson(body, archiving, "the archive").archived)).archived === true };
			default:
				return { result: await host.withdraw(id, parseJson(body, withdrawal, "the withdrawal").submission) };
		}
	}

	/** Session `id`'s changes, or one file's diff when `file` is given. Only a file in its changes has a diff. */
	async function changes(id: number, file: string | null): Promise<unknown> {
		const record = await host.sessions.get(id);
		if (record === undefined) throw new HttpError(404, `No session ${id}`);
		if (record.base === undefined) {
			const reason = record.baseError === undefined ? "this session started before aludra recorded changes" : record.baseError;
			if (file !== null) throw new HttpError(404, reason);
			return { available: false, reason };
		}
		const summary = await changesSince(record.base);
		if (file === null) return summary;
		if (!summary.available || !summary.files.some((f) => f.path === file)) throw new HttpError(404, `${file} hasn't changed in this session`);
		return { path: file, patch: await fileDiff(record.base, file) };
	}

	/** The Tailscale login of whoever asks, if it's one let in. tailscale serve sets it for a person's device; tagged
	 * devices and anything else get no header. */
	function loginOf(request: IncomingMessage): string | undefined {
		const login = request.headers["tailscale-user-login"];
		return typeof login === "string" && options.users.includes(login) ? login : undefined;
	}

	async function route(request: IncomingMessage, response: ServerResponse, login: string) {
		const url = new URL(request.url ?? "/", "http://host");
		const path = url.pathname;
		if (request.method === "GET" || request.method === "HEAD") {
			if (path === "/api/bootstrap") return json(response, await bootstrap(login));
			const changed = /^\/api\/sessions\/(\d+)\/changes(\/diff)?$/.exec(path);
			if (changed !== null) return json(response, await changes(Number(changed[1]), changed[2] === undefined ? null : url.searchParams.get("path") ?? ""));
			if (path === "/api/push") return json(response, await pushState());
			if (path === "/api/settings") return json(response, host.settings.get());
			const picture = /^\/api\/sessions\/(\d+)\/images\/(\d+)\/(\d+)\/(\d+)$/.exec(path);
			if (picture !== null) {
				const [id, entry, message, block] = picture.slice(1).map(Number) as [number, number, number, number];
				if ((await host.sessions.get(id)) === undefined) throw new HttpError(404, `No session ${id}`);
				const found = await host.image(id, entry, message, block);
				if (found === undefined || !(IMAGE_TYPES as readonly string[]).includes(found.mimeType)) throw new HttpError(404, "No image there");
				// Stored images never change, so the app can keep them.
				return reply(response, 200, Buffer.from(found.data, "base64"), found.mimeType, "private, max-age=31536000, immutable");
			}
			throw new HttpError(404, "Not found");
		}
		if (request.method !== "POST") throw new HttpError(405, "Method not allowed");
		// The app's address, which push services are given as aludra's contact: tailscale serve sets the host and is HTTPS.
		const origin = `https://${request.headers["x-forwarded-host"] ?? request.headers.host}`;
		return json(response, await post(path, await readBody(request, bodyLimit(path)), origin));
	}

	const server = createServer((request, response) => {
		const login = loginOf(request);
		if (login === undefined) return reply(response, 403, "Forbidden", "text/plain");
		if (request.method === "POST" && !sameOrigin(request, true)) return reply(response, 403, "Cross-site request", "text/plain");
		route(request, response, login).catch((error) => {
			const status = error instanceof HttpError ? error.status : error instanceof ParseError ? 400 : /^no (session|project|model|idea)|could be/.test(String(error?.message)) ? 404 : 500;
			if (status === 500) console.error("[api]", error);
			if (!response.headersSent) reply(response, status, error instanceof Error ? error.message : String(error), "text/plain");
			else response.end();
		});
	});

	const sockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
	// The amyrlin Mac app (src/amyrlin/endpoint.ts). A native app sends no Origin, and a browser always does, so a web
	// page can't open this socket with the user's Tailscale identity.
	const amyrlin = createAmyrlinEndpoint(host, { name: options.name ?? hostname().split(".")[0]! });
	// Messages from the Mac carry images, scaled down there but up to 5 MB each, and up to 40 MB of video (src/videos.ts),
	// all as base64.
	const amyrlinSockets = new WebSocketServer({ noServer: true, maxPayload: 112 * 1024 * 1024 });
	server.on("upgrade", (request, socket, head) => {
		const path = new URL(request.url ?? "/", "http://host").pathname;
		if (path === "/amyrlin") {
			const login = loginOf(request);
			if (login === undefined || request.headers.origin !== undefined) {
				socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
				return;
			}
			const name = request.headers["tailscale-user-name"];
			amyrlinSockets.handleUpgrade(request, socket, head, (ws) => amyrlin.connect(ws, { login, name: typeof name === "string" ? name : login }));
			return;
		}
		if (path !== "/api/live" || loginOf(request) === undefined || !sameOrigin(request, false)) {
			socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
			return;
		}
		sockets.handleUpgrade(request, socket, head, (ws) => connectLive(ws));
	});

	function connectLive(ws: WebSocket) {
		const send = (event: ServerEvent) => {
			if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
		};
		const client = live.connect(send);
		const watcher = { session: null as number | null, visible: true };
		watchers.set(ws, watcher);
		// Proxies drop a WebSocket that says nothing for a while.
		const ping = setInterval(() => ws.ping(), 25_000);
		ws.on("message", (data) => {
			let event: ClientEvent;
			try {
				const parsed = parseJson(String(data), clientEvent, "the event");
				event = parsed.type === "visible" ? { type: "visible", visible: parsed.visible ?? true } : { type: "follow", session: parsed.session ?? null };
			} catch (error) {
				send({ type: "error", message: error instanceof Error ? error.message : String(error) });
				return;
			}
			if (event.type === "visible") {
				watcher.visible = event.visible;
				return;
			}
			watcher.session = event.session;
			client.follow(event.session);
		});
		ws.on("close", () => {
			clearInterval(ping);
			watchers.delete(ws);
			client.close();
		});
		ws.on("error", () => {});
	}

	return {
		server,
		listen: (port: number, done?: () => void) => server.listen(port, "127.0.0.1", done),
		close: async () => {
			stopRunEnd();
			if (options.live === undefined) live.close();
			stopApprovals();
			for (const timer of timers) clearTimeout(timer);
			for (const ws of sockets.clients) ws.terminate();
			sockets.close();
			amyrlin.close();
			for (const ws of amyrlinSockets.clients) ws.terminate();
			amyrlinSockets.close();
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}
