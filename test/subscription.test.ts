import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { context } from "../src/host.ts";
import { renderSessions } from "../src/listing.ts";
import { mergeSubscription, RATE_LIMIT_DIAGNOSTIC, subscriptionLine, subscriptionNow, subscriptionOf } from "../src/subscription.ts";
import { fakeClaudeCode, makeProject, testHost } from "./helpers.ts";

const NOW = Date.UTC(2026, 10, 19, 15, 0) / 1000;
const HOUR = 3600;

/** What Claude Code 2.1.3xx sends: the nearest window at the top and every window in unifiedWindows. */
const UNIFIED = {
	status: "allowed",
	rateLimitType: "five_hour",
	utilization: 0.42,
	resetsAt: NOW + 2 * HOUR,
	isUsingOverage: false,
	overageStatus: "rejected",
	overageDisabledReason: "org_level_disabled",
	unifiedWindows: {
		five_hour: { utilization: 0.42, resetsAt: NOW + 2 * HOUR, status: "allowed" },
		seven_day: { utilization: 0.18, resetsAt: NOW + 90 * HOUR },
	},
};

/** An answer from Claude Code carrying `info` as pi-claude-code attaches it. */
function answer(text: string, info: object, at = NOW * 1000): AssistantMessage {
	return { ...fauxAssistantMessage(fauxText(text)), diagnostics: [{ type: "claude-code.turn-relay", timestamp: at }, { type: RATE_LIMIT_DIAGNOSTIC, timestamp: at, details: info as never }] };
}

test("a rate-limit report gives each window's use and reset, from unifiedWindows and the top-level window", () => {
	const known = subscriptionOf(UNIFIED, NOW * 1000)!;
	assert.equal(known.status, "allowed");
	assert.deepEqual(known.windows, {
		five_hour: { used: 0.42, resetsAt: (NOW + 2 * HOUR) * 1000, status: "allowed" },
		seven_day: { used: 0.18, resetsAt: (NOW + 90 * HOUR) * 1000 },
	});
	assert.deepEqual(known.overage, { status: "rejected", inUse: false, disabledReason: "org_level_disabled" });

	// An older Claude Code: only the window nearest its limit, and no overage at all.
	const old = subscriptionOf({ status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.81, resetsAt: NOW + 50 * HOUR }, NOW * 1000)!;
	assert.deepEqual(old.windows, { seven_day: { used: 0.81, resetsAt: (NOW + 50 * HOUR) * 1000, status: "allowed_warning" } });
	assert.equal(old.overage, undefined);
	// The credit pool isn't a window, and a report without a status isn't a report.
	assert.deepEqual(subscriptionOf({ status: "allowed", rateLimitType: "overage", utilization: 0.1, resetsAt: NOW }, 0)!.windows, {});
	assert.equal(subscriptionOf({ utilization: 0.5 }, 0), undefined);
	assert.equal(subscriptionOf("allowed", 0), undefined);
});

test("windows heard one at a time add up, a reset window drops out, and an older report changes nothing", () => {
	const five = subscriptionOf({ status: "allowed", rateLimitType: "five_hour", utilization: 0.3, resetsAt: NOW + HOUR }, NOW * 1000)!;
	const seven = subscriptionOf({ status: "allowed", rateLimitType: "seven_day", utilization: 0.6, resetsAt: NOW + 40 * HOUR }, (NOW + 60) * 1000)!;
	const both = mergeSubscription(five, seven);
	assert.deepEqual(Object.keys(both.windows).sort(), ["five_hour", "seven_day"]);
	assert.equal(mergeSubscription(both, five), both, "an older report is ignored");
	// After the five-hour window resets, it's gone until an answer reports it again.
	assert.deepEqual(Object.keys(subscriptionNow(both, (NOW + 2 * HOUR) * 1000)!.windows), ["seven_day"]);
	const later = subscriptionOf({ status: "allowed", rateLimitType: "seven_day", utilization: 0.61, resetsAt: NOW + 40 * HOUR }, (NOW + 2 * HOUR) * 1000)!;
	assert.deepEqual(Object.keys(mergeSubscription(both, later).windows), ["seven_day"]);
});

test("the terminal line names each window's use and reset, and says when the limit is reached or credit is in use", () => {
	const at = NOW * 1000;
	const line = subscriptionLine(subscriptionOf(UNIFIED, at), at)!;
	assert.match(line, /^Claude: 5h 42% until \d+:\d\d [AP]M · 7d 18% until \w{3} \d+:\d\d [AP]M$/);
	const rejected = subscriptionLine(subscriptionOf({ ...UNIFIED, status: "rejected", isUsingOverage: true }, at), at)!;
	assert.match(rejected, /^Claude: limit reached · 5h .* · on usage credit$/);
	assert.equal(subscriptionLine(undefined, at), undefined);
	assert.equal(subscriptionLine(subscriptionOf({ status: "allowed" }, at), at), undefined, "no windows, no line");
	const lines = renderSessions([{ id: 1, workspace: "w", project: "p", dir: "/p", title: "t", createdAt: at, updatedAt: at, state: "done", line: "" }], {}, { depth: 1, width: 100 }, at, undefined, subscriptionOf(UNIFIED, at));
	assert.match(lines.at(-1)!, /^Claude: 5h 42%/);
});

test("the host keeps the windows from each Claude answer, tells listeners, and has them again after a restart", async (t) => {
	const at = Date.now();
	const resets = Math.round(at / 1000) + 2 * HOUR;
	const { claudeCode } = fakeClaudeCode([
		answer("first", { status: "allowed", rateLimitType: "five_hour", utilization: 0.2, resetsAt: resets }, at),
		answer("second", { status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.8, resetsAt: resets + 50 * HOUR }, at + 1),
	]);
	const { host, dir } = await testHost(t, { claudeCode });
	assert.equal(host.subscription.get(), undefined, "nothing until an answer says");
	const heard: string[] = [];
	host.subscription.onChange((s) => heard.push(s.status));
	const session = await host.sessions.create(makeProject(dir, "one"), "one");
	await (await host.submit(session.id, "hi")).wait(context);
	assert.deepEqual(host.subscription.get()?.windows.five_hour, { used: 0.2, resetsAt: resets * 1000, status: "allowed" });
	await (await host.submit(session.id, "again")).wait(context);
	const known = host.subscription.get()!;
	assert.equal(known.status, "allowed_warning");
	assert.deepEqual(Object.keys(known.windows).sort(), ["five_hour", "seven_day"], "the five-hour window stays until it resets");
	assert.deepEqual(heard, ["allowed", "allowed_warning"]);

	await host.close();
	const { claudeCode: again } = fakeClaudeCode([]);
	const { host: reopened } = await testHost(t, { claudeCode: again, dir });
	assert.deepEqual(reopened.subscription.get(), known);
});
