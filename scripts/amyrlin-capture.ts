// Records one session's /amyrlin frames from an aludra host with a faux model, for the amyrlin Mac app's tests
// (amyrlin's fixtures/server-v1/session.jsonl, read by ServerCaptureTests). One frame's events per line.
//   node --no-warnings scripts/amyrlin-capture.ts ../amyrlin/fixtures/server-v1/session.jsonl
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { WebSocket } from "ws";
import { createApi } from "../src/api.ts";
import type { Json } from "../src/amyrlin/translate.ts";
import { configFor } from "../src/config.ts";
import { openHost } from "../src/host.ts";

const out = resolve(process.argv[2] ?? "session.jsonl");
const USER = "you@example.com";
const dir = mkdtempSync(join(tmpdir(), "aludra-capture-"));
const projectDir = join(dir, "Projects", "Software", "demo");
mkdirSync(projectDir, { recursive: true });

const last = (ctx: TranscriptContext) => JSON.stringify(ctx.messages.findLast((m) => m.role === "user")?.content ?? "");
const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", name: "Faux 1", contextWindow: 200_000 }], tokensPerSecond: 200 });
faux.setResponses(Array.from({ length: 100 }, () => (ctx: TranscriptContext) => {
	const final = ctx.messages.at(-1);
	if (final?.role === "toolResult") return fauxAssistantMessage(fauxText(`The ${final.toolName} call came back.`));
	if (/push/.test(last(ctx))) return fauxAssistantMessage(fauxToolCall("bash", { command: "git push --dry-run 2>&1 || true" }), { stopReason: "toolUse" });
	if (/slow/.test(last(ctx))) return fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 1 && echo slept" }), { stopReason: "toolUse" });
	return fauxAssistantMessage(fauxText("Hello from aludra's faux model, streamed a few words at a time."));
}));
const models = createModels();
models.setProvider(faux.provider);
const { config } = configFor(JSON.stringify({ dataDir: join(dir, "data"), workspaces: [{ name: "capture", roots: [join(dir, "Projects", "*", "*")] }] }), {});
const host = await openHost({ config, models, model: { provider: "faux", modelId: "faux-1" }, agentDir: join(dir, "agent"), onNotice: () => {} });
host.resume();
const api = createApi(host, { users: [USER], name: "capture" });
await new Promise<void>((done) => api.listen(0, done));
const url = `ws://127.0.0.1:${(api.server.address() as AddressInfo).port}/amyrlin`;

const ws = new WebSocket(url, { headers: { "tailscale-user-login": USER } });
await new Promise((done) => ws.once("open", done));
const frames: Json[][] = [];
const responses = new Map<string, Json>();
let wake = () => {};
ws.on("message", (data) => {
	const frame = JSON.parse(String(data));
	if (frame.type === "event" && frame.subscription === "s1") frames.push(frame.events);
	if (frame.type === "response") responses.set(frame.id, frame);
	wake();
});
const until = async (check: () => boolean, what: string) => {
	const deadline = Date.now() + 15_000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise<void>((done) => {
			wake = done;
			setTimeout(done, 50);
		});
	}
};
let next = 0;
const request = async (method: string, params: Json): Promise<Json> => {
	const id = String(++next);
	ws.send(JSON.stringify({ type: "request", id, method, params }));
	await until(() => responses.has(id), method);
	const response = responses.get(id);
	if (response.error) throw new Error(`${method}: ${response.error.message}`);
	return response.result;
};
const seen = (test: (e: Json) => boolean) => frames.flat().filter(test).length;
const ended = () => seen((e) => e.type === "run.ended");

ws.send(JSON.stringify({ type: "hello", protocols: [1], client: { name: "capture", version: "0" } }));
const id = (await request("conversations.create", { requestId: "capture", project: projectDir })).conversation.id;
await request("conversation.watch", { conversationId: id }); // s1
await until(() => frames.length > 0, "the snapshot");

await request("submit", { conversationId: id, requestId: "c1", text: "hello" });
await until(() => ended() >= 1, "the plain run");
await request("submit", { conversationId: id, requestId: "c2", text: "run something slow" });
await until(() => seen((e) => e.type === "tool.started") >= 1, "the slow tool");
await request("submit", { conversationId: id, requestId: "c3", text: "and a follow-up" });
await until(() => ended() >= 3, "the slow run and its follow-up");
await request("configure", { conversationId: id, changes: { thinkingLevel: "low" } });
await until(() => seen((e) => e.type === "settings.changed") >= 1, "settings");
await request("submit", { conversationId: id, requestId: "c4", text: "push it" });
await until(() => seen((e) => e.type === "approval.requested") >= 1, "the approval");
const approval = frames.flat().find((e) => e.type === "approval.requested").approval;
await request("approval.answer", { approvalId: approval.approvalId, decision: "approve" });
await until(() => ended() >= 4, "the approved run");
await request("submit", { conversationId: id, requestId: "c5", text: "push again" });
await until(() => seen((e) => e.type === "approval.requested") >= 2, "the second approval");
await request("abort", { conversationId: id });
await until(() => ended() >= 5, "the stopped run");
await request("reset", { conversationId: id, handoff: "Starting over." });
await until(() => seen((e) => e.type === "item.added" && e.item.type === "reset") >= 1, "the reset");
await new Promise((done) => setTimeout(done, 300));

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, frames.map((events) => JSON.stringify(events)).join("\n") + "\n");
console.log(`${frames.length} frames to ${out}`);
ws.close();
await api.close();
await host.close();
rmSync(dir, { recursive: true, force: true });
