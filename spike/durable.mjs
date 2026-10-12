// Spike from 2026-10-11, kept as a reference; see docs/plan.md "Spike findings". Ran from /tmp with gaidin's node_modules symlinked in.
import { createRequire } from "node:module";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { AssistantEntry, createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";

const G = "/home/brad/.local/share/pi-node/node-v22.23.2-linux-x64/lib/node_modules/@earendil-works";
const here = new URL(".", import.meta.url).pathname;
const { createJiti } = createRequire(`${G}/pi-coding-agent/package.json`)("jiti");
const jiti = createJiti(import.meta.url, {
  alias: {
    "@earendil-works/pi-ai/compat": `${here}node_modules/@earendil-works/pi-ai/dist/compat.js`,
    "@earendil-works/pi-ai": `${here}node_modules/@earendil-works/pi-ai/dist/index.js`,
    "@earendil-works/pi-coding-agent": `${G}/pi-coding-agent/dist/index.js`,
    "@earendil-works/pi-tui": `${G}/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/index.js`,
  },
});
const bridge = await jiti.import("/home/brad/.pi/agent/npm/node_modules/pi-claude-bridge/src/index.ts", { default: true });

// Stand-in for pi's ExtensionAPI: keep the provider, ignore everything else.
let config;
const api = new Proxy({}, { get: (_, k) => k === "registerProvider" ? (_id, c) => { config = c; } : () => undefined });
await bridge(api);
if (!config) throw new Error("bridge registered no provider");

// Pi Durable aborts each request's signal once that request is done; the bridge keeps one Claude Code
// query alive across requests and ties it to the first signal. Forward only aborts of a running stream.
const controllers = new Map();
// After a restart the bridge has no live query, and a transcript ending in a tool result makes it end
// the turn empty. A user note sends it down its rebuild path instead; the note is not stored.
const seen = new Set();
function bridged(m, c, o = {}) {
  const key = o.sessionId ?? "default";
  if (!seen.has(key)) {
    seen.add(key);
    if (c.messages.at(-1)?.role === "toolResult") {
      c = { ...c, messages: [...c.messages, { role: "user", content: [{ type: "text", text: "(Continuing where we left off.)" }], timestamp: Date.now() }] };
    }
  }
  let ctl = controllers.get(key);
  if (!ctl || ctl.signal.aborted) controllers.set(key, (ctl = new AbortController()));
  let running = true;
  o.signal?.addEventListener("abort", () => { if (running) ctl.abort(o.signal.reason); }, { once: true });
  const stream = config.streamSimple(m, c, { ...o, signal: ctl.signal });
  stream.result().finally(() => { running = false; });
  return stream;
}
const provider = {
  id: "claude-bridge", name: "Claude bridge",
  auth: { apiKey: { name: "Claude Code login", resolve: async () => ({ auth: {} }) } },
  getModels: () => config.models.map((m) => ({ ...m, provider: "claude-bridge", api: "claude-bridge", baseUrl: "claude-bridge" })),
  stream: bridged,
  streamSimple: bridged,
};
const models = createModels();
models.setProvider(provider);

const registry = createRegistry();
registry.install(CodingTools);
const harness = await Harness.open(await openNodeSqliteStorage(`${here}spike.sqlite`), {
  models, registry, settings: { extensions: [CodingTools] },
  env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? `${here}work` }),
}, ctx);
const root = await harness.root(ctx, { agent: { model: { provider: "claude-bridge", modelId: "claude-opus-5-5" }, cwd: `${here}work` } });
import { readFileSync, writeFileSync } from "node:fs";
let sub;
if (process.argv[2] === "--resume") {
  harness.resume();
  sub = await harness.submission(Number(readFileSync(`${here}submission-id`, "utf8")));
} else {
  sub = await root.submit({ type: "input", content: process.argv[2] }, ctx);
  writeFileSync(`${here}submission-id`, String(sub.id));
}
const settled = await sub.wait(ctx);
console.log("settled:", JSON.stringify(settled).slice(0, 1500));
if (settled.status === "done") {
  const a = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), ctx);
  const msg = a?.model?.[0] ?? a;
  console.log("answer:", JSON.stringify(msg?.content ?? msg).slice(0, 400));
  console.log("usage:", JSON.stringify(msg?.usage ?? null));
}
await harness.close(ctx);
process.exit(0);
