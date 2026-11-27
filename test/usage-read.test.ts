// Reading the subscription's windows fresh (src/usage-read.ts) from a stand-in for Anthropic's usage endpoint, with a
// login directory of the test's own; and the host reading them when a client watches, at most once a minute.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { WebSocket } from "ws";
import { createApi } from "../src/api.ts";
import type { Json } from "../src/app/translate.ts";
import { readUsage, usageSubscription, UsageUnavailable } from "../src/usage-read.ts";
import { tempDir, testHost } from "./helpers.ts";

const HOUR = 3_600_000;
const USER = "you@example.com";

/** An answer in the endpoint's shape: utilization in percent, resets_at as ISO times. */
function answer(fiveHour: number, sevenDay: number, now = Date.now(), extra: Record<string, unknown> = {}) {
	return {
		five_hour: { utilization: fiveHour, resets_at: new Date(now + 2 * HOUR).toISOString() },
		seven_day: { utilization: sevenDay, resets_at: new Date(now + 5 * 24 * HOUR).toISOString() },
		seven_day_opus: null,
		extra_usage: { is_enabled: false },
		limits: [{ kind: "session", severity: "normal" }],
		...extra,
	};
}

/** A stand-in for the endpoint: answers `body()` to a request with the login's token, counts requests. */
async function endpoint(t: TestContext, body: () => unknown, status = () => 200) {
	const seen: { auth?: string; beta?: string }[] = [];
	const server = createServer((req: IncomingMessage, res) => {
		seen.push({ auth: req.headers.authorization, beta: req.headers["anthropic-beta"] as string | undefined });
		if (req.headers.authorization !== "Bearer sk-test-token") return void res.writeHead(401).end();
		res.writeHead(status(), { "content-type": "application/json" });
		res.end(JSON.stringify(body()));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
	return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/oauth/usage`, seen };
}

/** A Claude Code config directory holding a login. */
function login(t: TestContext, expiresAt = Date.now() + HOUR): string {
	const dir = join(tempDir(t), "claude");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "sk-test-token", refreshToken: "r", expiresAt } }), { mode: 0o600 });
	return dir;
}

test("the endpoint's answer becomes the windows: fractions, ms, null windows left out, status from use and severity", () => {
	const now = 1_800_000_000_000;
	const read = usageSubscription(answer(49, 18, now), now)!;
	assert.deepEqual(read, {
		at: now,
		status: "allowed",
		windows: { five_hour: { used: 0.49, resetsAt: now + 2 * HOUR }, seven_day: { used: 0.18, resetsAt: now + 5 * 24 * HOUR } },
	});
	assert.equal(usageSubscription(answer(100, 18, now), now)!.status, "rejected");
	assert.equal(usageSubscription(answer(100, 18, now), now)!.windows.five_hour!.status, "rejected");
	assert.equal(usageSubscription(answer(85, 18, now, { limits: [{ severity: "warning" }] }), now)!.status, "allowed_warning");
	assert.equal(usageSubscription({ five_hour: null }, now), undefined);
	assert.equal(usageSubscription("nope", now), undefined);
});

test("a read sends the login's token and the OAuth beta header; no login, an expired token or a refusal is UsageUnavailable", async (t) => {
	const stand = await endpoint(t, () => answer(38, 17));
	const read = await readUsage({ configDir: login(t), named: true }, { url: stand.url, platform: "linux" });
	assert.equal(read.windows.five_hour!.used, 0.38);
	assert.deepEqual(stand.seen.at(-1), { auth: "Bearer sk-test-token", beta: "oauth-2025-04-20" });
	await assert.rejects(readUsage({ configDir: join(tempDir(t), "none"), named: true }, { url: stand.url, platform: "linux" }), UsageUnavailable);
	const count = stand.seen.length;
	await assert.rejects(readUsage({ configDir: login(t, Date.now() - 1000), named: true }, { url: stand.url, platform: "linux" }), /expired/);
	assert.equal(stand.seen.length, count, "an expired token isn't sent");
	const refusing = await endpoint(t, () => ({}), () => 429);
	await assert.rejects(readUsage({ configDir: login(t), named: true }, { url: refusing.url, platform: "linux" }), /HTTP 429/);
});

test("a client watching gets the windows read fresh as host.subscription, at most one read a minute, and `at` is when they were read", async (t) => {
	let fiveHour = 38;
	const stand = await endpoint(t, () => answer(fiveHour, 17));
	const { host } = await testHost(t, { usage: { url: stand.url, configDir: login(t) } });
	const server = createApi(host, { users: [USER], name: "test-host" });
	await new Promise<void>((resolve) => server.listen(0, resolve));
	t.after(() => server.close());
	const ws = new WebSocket(`ws://127.0.0.1:${(server.server.address() as AddressInfo).port}/app`, { headers: { "tailscale-user-login": USER } });
	t.after(() => ws.close());
	const events: Json[] = [];
	const responses = new Map<string, Json>();
	ws.on("message", (data) => {
		const frame = JSON.parse(String(data));
		if (frame.type === "event") events.push(...frame.events);
		if (frame.type === "response") responses.set(frame.id, frame.result);
	});
	await new Promise((resolve) => ws.once("open", resolve));
	ws.send(JSON.stringify({ type: "hello", protocols: [1], client: { name: "test", version: "0" } }));
	const until = async <T>(check: () => T | undefined, what: string) => {
		for (let i = 0; i < 200; i++) {
			const found = check();
			if (found !== undefined) return found;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		throw new Error(`timed out waiting for ${what}`);
	};
	const before = Date.now();
	ws.send(JSON.stringify({ type: "request", id: "w", method: "host.watch", params: {} }));
	const fresh = await until(() => events.find((e) => e.type === "host.subscription"), "host.subscription");
	assert.equal(fresh.subscription.windows.five_hour.used, 0.38);
	assert.equal(fresh.subscription.windows.seven_day.used, 0.17);
	assert.ok(fresh.subscription.at >= before && fresh.subscription.at <= Date.now(), "at is when it was read");
	assert.equal(stand.seen.length, 1);

	// Asking again within the minute reads nothing, even when it's asked to.
	fiveHour = 60;
	await host.subscription.refresh(0);
	assert.equal(stand.seen.length, 1);
	ws.send(JSON.stringify({ type: "request", id: "i", method: "host.info", params: {} }));
	assert.equal((await until(() => responses.get("i"), "host.info")).subscription.windows.five_hour.used, 0.38);
});

test("a window whose resetsAt has passed is left out with no new report, and a host with no Claude login reads nothing", async (t) => {
	const now = Date.now();
	const stand = await endpoint(t, () => ({ ...answer(38, 17, now), five_hour: { utilization: 38, resets_at: new Date(now + 300).toISOString() } }));
	const { host } = await testHost(t, { usage: { url: stand.url, configDir: login(t) } });
	await host.subscription.refresh();
	assert.deepEqual(Object.keys(host.subscription.get()!.windows).sort(), ["five_hour", "seven_day"]);
	await new Promise((resolve) => setTimeout(resolve, 400));
	assert.deepEqual(Object.keys(host.subscription.get()!.windows), ["seven_day"]);

	// The faux host with no usage setting runs no Claude model, so it never reads.
	const plain = await testHost(t);
	await plain.host.subscription.refresh(0);
	assert.equal(plain.host.subscription.get(), undefined);
});
