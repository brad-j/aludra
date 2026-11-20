// The Claude subscription's usage windows, from the `claude-code.rate-limit` diagnostic pi-claude-code puts on each answer:
// Claude Code's last `rate_limit_event` of the turn. Claude Code 2.1.3xx sends every window it read from the response
// headers in `unifiedWindows`; older versions send only the window nearest its limit, named by `rateLimitType`, with
// `utilization` and `resetsAt`. So each answer may update some windows, and the host keeps the latest of each until it
// resets.
import type { Message } from "@earendil-works/pi-ai";

/** The diagnostic's type, as pi-claude-code names it. */
export const RATE_LIMIT_DIAGNOSTIC = "claude-code.rate-limit";

export type LimitStatus = "allowed" | "allowed_warning" | "rejected";

/** One window: how much of it is used (a fraction, past 1 when use ran over the cap) and when it resets, in ms. */
export type UsageWindow = { used: number; resetsAt: number; status?: LimitStatus };

/**
 * What the host last heard of the subscription. `windows` is keyed by Claude Code's names (`five_hour`, `seven_day`,
 * `seven_day_overage_included`, `seven_day_opus`, `seven_day_sonnet`); `status` is whether requests go through now;
 * `overage` is the usage-credit state when Claude Code reported one. `at` is when, in ms.
 */
export type Subscription = {
	at: number;
	status: LimitStatus;
	windows: Record<string, UsageWindow>;
	overage?: { status?: LimitStatus; resetsAt?: number; inUse: boolean; disabledReason?: string };
};

const STATUSES = new Set<string>(["allowed", "allowed_warning", "rejected"]);
const statusOf = (value: unknown): LimitStatus | undefined => (typeof value === "string" && STATUSES.has(value) ? (value as LimitStatus) : undefined);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const record = (value: unknown): Record<string, unknown> | undefined => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);

/** A window from `utilization` and `resetsAt` in seconds, or undefined when either is missing. */
function windowOf(used: unknown, resetsAt: unknown, status: unknown): UsageWindow | undefined {
	if (!finite(used) || !finite(resetsAt)) return undefined;
	const s = statusOf(status);
	return { used, resetsAt: resetsAt * 1000, ...(s === undefined ? {} : { status: s }) };
}

/** The subscription as one `rate_limit_info` reports it, heard at `at`; undefined when it isn't one. */
export function subscriptionOf(details: unknown, at: number): Subscription | undefined {
	const info = record(details);
	const status = statusOf(info?.status);
	if (info === undefined || status === undefined) return undefined;
	const windows: Record<string, UsageWindow> = {};
	// The top-level fields describe the window named by rateLimitType; "overage" is the credit pool, not a window.
	if (typeof info.rateLimitType === "string" && info.rateLimitType !== "overage") {
		const top = windowOf(info.utilization, info.resetsAt, status);
		if (top !== undefined) windows[info.rateLimitType] = top;
	}
	for (const [name, value] of Object.entries(record(info.unifiedWindows) ?? {})) {
		const window = record(value);
		const found = window === undefined ? undefined : windowOf(window.utilization, window.resetsAt, window.status);
		if (found !== undefined) windows[name] = found;
	}
	const overageStatus = statusOf(info.overageStatus);
	const inUse = info.isUsingOverage === true || info.overageInUse === true;
	const overage = overageStatus === undefined && !inUse ? undefined : {
		...(overageStatus === undefined ? {} : { status: overageStatus }),
		...(finite(info.overageResetsAt) ? { resetsAt: info.overageResetsAt * 1000 } : {}),
		inUse,
		...(typeof info.overageDisabledReason === "string" ? { disabledReason: info.overageDisabledReason } : {}),
	};
	return { at, status, windows, ...(overage === undefined ? {} : { overage }) };
}

/** The subscription an answer reports, from its rate-limit diagnostic; undefined for any other message. */
export function subscriptionIn(message: Message): Subscription | undefined {
	if (message.role !== "assistant") return undefined;
	const diagnostic = message.diagnostics?.findLast((d) => d.type === RATE_LIMIT_DIAGNOSTIC);
	return diagnostic === undefined ? undefined : subscriptionOf(diagnostic.details, diagnostic.timestamp || message.timestamp);
}

/**
 * `next` heard after `known`: its windows over the ones before, which stay until they reset, since a Claude Code that
 * sends one window at a time leaves the others as they were. An older report changes nothing.
 */
export function mergeSubscription(known: Subscription | undefined, next: Subscription): Subscription {
	if (known !== undefined && next.at < known.at) return known;
	return { ...next, windows: { ...current(known?.windows ?? {}, next.at), ...next.windows } };
}

/** `windows` without the ones that reset by `now`. */
function current(windows: Record<string, UsageWindow>, now: number): Record<string, UsageWindow> {
	return Object.fromEntries(Object.entries(windows).filter(([, w]) => w.resetsAt > now));
}

/** The subscription as of `now`: windows that have reset since are left out, as is usage credit whose period ended. */
export function subscriptionNow(known: Subscription | undefined, now = Date.now()): Subscription | undefined {
	if (known === undefined) return undefined;
	const { overage, ...rest } = known;
	const keep = overage !== undefined && (overage.resetsAt === undefined || overage.resetsAt > now);
	return { ...rest, windows: current(known.windows, now), ...(keep ? { overage } : {}) };
}

const LABELS: Record<string, string> = { five_hour: "5h", seven_day: "7d", seven_day_opus: "7d Opus", seven_day_sonnet: "7d Sonnet", seven_day_overage_included: "7d incl. credit" };

/** When `at` is, short: a time today, else a weekday and time, in the machine's zone. */
function whenShort(at: number, now: number): string {
	const date = new Date(at);
	const time = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
	return new Date(now).toDateString() === date.toDateString() ? time : `${date.toLocaleDateString("en-US", { weekday: "short" })} ${time}`;
}

/** One line for a terminal, `Claude: 5h 42% until 3:10 PM · 7d 18% until Mon 9:00 AM`, or undefined with no windows. */
export function subscriptionLine(known: Subscription | undefined, now = Date.now()): string | undefined {
	const shown = subscriptionNow(known, now);
	if (shown === undefined) return undefined;
	const names = Object.keys(shown.windows).sort((a, b) => (LABELS[a] === undefined ? 1 : 0) - (LABELS[b] === undefined ? 1 : 0) || Object.keys(LABELS).indexOf(a) - Object.keys(LABELS).indexOf(b));
	const parts = names.map((name) => {
		const w = shown.windows[name]!;
		return `${LABELS[name] ?? name} ${Math.round(w.used * 100)}% until ${whenShort(w.resetsAt, now)}`;
	});
	if (shown.status === "rejected") parts.unshift("limit reached");
	if (shown.overage?.inUse === true) parts.push("on usage credit");
	return parts.length === 0 ? undefined : `Claude: ${parts.join(" · ")}`;
}
