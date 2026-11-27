// The subscription's windows as they are now, read the way Claude Code's own usage view reads them: GET
// /api/oauth/usage on Anthropic's API with the OAuth token of the Claude Code login aludra runs on (claude.configDir).
// It's not a model request, so it costs nothing and spends no window. The answer has every window the account has,
// whoever spent it: Claude Code in a terminal, claude.ai, or this host's sessions.
//
// The token is read where Claude Code keeps it: `.credentials.json` in its config directory, or on macOS the login
// keychain item Claude Code names after that directory. It's only read, never refreshed or written: an expired token
// means no read until Claude Code's next request refreshes it, so the host never races Claude Code over its login.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import type { LimitStatus, Subscription, UsageWindow } from "./subscription.ts";

export const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const TIMEOUT_MS = 10_000;

/** Where the login is: Claude Code's config directory, and whether it was named (CLAUDE_CONFIG_DIR) or is the default. */
export type UsageLogin = { configDir: string; named: boolean };

/** Why there was no read, said once in the host's log: no login, an expired token, or the endpoint refusing. */
export class UsageUnavailable extends Error {}

type OAuth = { accessToken?: unknown; expiresAt?: unknown };

/** The login's OAuth token, or why there's none. */
async function tokenOf(login: UsageLogin, platform: NodeJS.Platform): Promise<string> {
	let oauth: OAuth | undefined;
	try {
		oauth = (JSON.parse(await readFile(join(login.configDir, ".credentials.json"), "utf8")) as { claudeAiOauth?: OAuth }).claudeAiOauth;
	} catch {
		if (platform === "darwin") oauth = await keychain(login);
	}
	if (oauth === undefined || typeof oauth.accessToken !== "string" || oauth.accessToken === "") throw new UsageUnavailable(`no Claude Code login at ${login.configDir}`);
	if (typeof oauth.expiresAt === "number" && oauth.expiresAt <= Date.now()) throw new UsageUnavailable("Claude Code's token has expired; it's refreshed by Claude Code's next request");
	return oauth.accessToken;
}

/** Claude Code's login on macOS: the keychain item it names "Claude Code-credentials", with its config directory's hash when one was named. */
async function keychain(login: UsageLogin): Promise<OAuth | undefined> {
	const suffix = login.named ? `-${createHash("sha256").update(login.configDir.normalize("NFC")).digest("hex").slice(0, 8)}` : "";
	const account = (() => {
		try {
			return process.env.USER || userInfo().username;
		} catch {
			return "claude-code-user";
		}
	})();
	const text = await new Promise<string | undefined>((resolve) => {
		execFile("security", ["find-generic-password", "-a", account, "-w", "-s", `Claude Code-credentials${suffix}`], { timeout: 5000 }, (error, stdout) => resolve(error ? undefined : stdout.trim()));
	});
	try {
		return text === undefined ? undefined : (JSON.parse(text) as { claudeAiOauth?: OAuth }).claudeAiOauth;
	} catch {
		return undefined;
	}
}

const record = (value: unknown): Record<string, unknown> | undefined => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);

/**
 * The endpoint's answer as a Subscription read at `at`: each window it gives (`five_hour`, `seven_day` and the
 * per-model ones), `utilization` a percentage and `resets_at` an ISO time. It has no request status, so `status` is
 * `rejected` when a window is used up, `allowed_warning` when one of its limits isn't at `normal` severity, else
 * `allowed`. Undefined when it isn't that shape.
 */
export function usageSubscription(body: unknown, at: number): Subscription | undefined {
	const data = record(body);
	if (data === undefined) return undefined;
	const windows: Record<string, UsageWindow> = {};
	for (const [name, value] of Object.entries(data)) {
		if (name !== "five_hour" && !name.startsWith("seven_day")) continue;
		const window = record(value);
		const resetsAt = typeof window?.resets_at === "string" ? Date.parse(window.resets_at) : Number.NaN;
		if (typeof window?.utilization !== "number" || !Number.isFinite(window.utilization) || !Number.isFinite(resetsAt)) continue;
		const used = window.utilization / 100;
		windows[name] = { used, resetsAt, ...(used >= 1 ? { status: "rejected" as const } : {}) };
	}
	if (Object.keys(windows).length === 0) return undefined;
	const limits = Array.isArray(data.limits) ? data.limits.map(record).filter((l) => l !== undefined) : [];
	const status: LimitStatus = Object.values(windows).some((w) => w.used >= 1) ? "rejected" : limits.some((l) => typeof l.severity === "string" && l.severity !== "normal") ? "allowed_warning" : "allowed";
	const extra = record(data.extra_usage);
	const overage = extra?.is_enabled === true ? { inUse: false, ...(typeof extra.disabled_reason === "string" ? { disabledReason: extra.disabled_reason } : {}) } : undefined;
	return { at, status, windows, ...(overage === undefined ? {} : { overage }) };
}

/** Reads the windows now. Throws UsageUnavailable when there's no usable login or the endpoint doesn't answer with them. */
export async function readUsage(login: UsageLogin, options: { url?: string; platform?: NodeJS.Platform; now?: () => number } = {}): Promise<Subscription> {
	const token = await tokenOf(login, options.platform ?? process.platform);
	let response: Response;
	try {
		response = await fetch(options.url ?? USAGE_URL, {
			headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", "content-type": "application/json" },
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch (error) {
		throw new UsageUnavailable(`the usage endpoint didn't answer: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!response.ok) throw new UsageUnavailable(`the usage endpoint answered HTTP ${response.status}`);
	const read = usageSubscription(await response.json().catch(() => undefined), (options.now ?? Date.now)());
	if (read === undefined) throw new UsageUnavailable("the usage endpoint's answer had no windows");
	return read;
}
