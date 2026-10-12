// Spike from 2026-10-11, kept as a reference; see docs/plan.md "Spike findings". Ran from /tmp with gaidin's node_modules symlinked in.
const base = "/home/brad/.local/share/pi-node/node-v22.23.2-linux-x64/lib/node_modules/@earendil-works/pi-coding-agent";
const { createAgentSession, SessionManager } = await import(`${base}/dist/index.js`);
const { session, extensionsResult } = await createAgentSession({
  cwd: process.argv[2],
  sessionManager: SessionManager.inMemory(),
});
if (session.bindExtensions) await session.bindExtensions({});
const want = session.modelRuntime.getAllModels("claude-bridge").find((m) => m.id === "claude-opus-5-5");
console.log("bridge models:", session.modelRuntime.getAllModels("claude-bridge").map((m) => m.id).join(", "));
if (want) await session.setModel(want);
console.log("model:", session.model?.provider, session.model?.id);
console.log("extensions:", (extensionsResult?.extensions ?? []).map((e) => e.path ?? e.name).join(", "));
console.log("tools:", session.getActiveToolNames().join(", "));
await session.prompt("Reply with exactly: bridge ok");
console.log("reply:", session.getLastAssistantText());
const last = session.messages.at(-1);
console.log("stop/error:", last?.stopReason, last?.errorMessage);
console.log("usage:", JSON.stringify(last?.usage ?? null));
session.dispose();
process.exit(0);
