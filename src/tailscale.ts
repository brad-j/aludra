// Tailscale, the way in: `tailscale serve` puts HTTPS in front of the API and vouches for who's asking. aludra uses the
// machine's own node, or a node of its own if one runs with its socket at tailscale/tailscaled.sock in the data
// directory (deploy/aludra-tailscale.service: a second tailscaled in userspace mode, so the app gets its own name).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";

/** Who and where this machine is on the tailnet. */
export type TailnetSelf = { dnsName: string; login?: string };

export type Tailscale = {
	/** The command line for `args`, for telling someone what to run. */
	command(...args: string[]): string;
	/** Runs `tailscale args`; undefined if tailscale isn't installed. */
	run(...args: string[]): { ok: boolean; stdout: string; stderr: string } | undefined;
};

export function tailscaleFor(config: Config): Tailscale {
	const socket = join(config.dataDir, "tailscale", "tailscaled.sock");
	const prefix = existsSync(socket) ? ["--socket", socket] : [];
	return {
		command: (...args) => ["tailscale", ...prefix, ...args].map((a) => (/^[\w./@:=-]+$/.test(a) ? a : JSON.stringify(a))).join(" "),
		run: (...args) => {
			const result = spawnSync("tailscale", [...prefix, ...args], { encoding: "utf8", timeout: 10_000 });
			return result.error === undefined ? { ok: result.status === 0, stdout: result.stdout, stderr: result.stderr } : undefined;
		},
	};
}

/** This node's name and its owner's login, from `tailscale status --json`. */
export function parseStatus(json: string): TailnetSelf | undefined {
	try {
		const status = JSON.parse(json) as { Self?: { DNSName?: string; UserID?: number }; User?: Record<string, { LoginName?: string }> };
		const dnsName = status.Self?.DNSName?.replace(/\.$/, "");
		if (!dnsName) return undefined;
		const login = status.Self?.UserID === undefined ? undefined : status.User?.[String(status.Self.UserID)]?.LoginName;
		return login === undefined ? { dnsName } : { dnsName, login };
	} catch {
		return undefined;
	}
}

export function tailnetSelf(tailscale: Tailscale): TailnetSelf | undefined {
	const status = tailscale.run("status", "--json");
	return status?.ok ? parseStatus(status.stdout) : undefined;
}

/** Whether `tailscale serve status --json` sends something to the API's port. */
export function servesPort(json: string, port: number): boolean {
	return json.includes(`127.0.0.1:${port}`) || json.includes(`localhost:${port}`);
}
