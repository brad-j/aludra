// `aludra doctor`: checks the settings and everything the host depends on, without starting it and without spending
// anything (after gaidin's doctor.ts). Loading the bridge starts no Claude Code query.
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_DIR } from "./api.ts";
import { loadBridge, PROVIDER } from "./bridge.ts";
import type { Config, Loaded } from "./config.ts";
import { expandRoot } from "./projects.ts";
import { isListening, socketPathFor } from "./server.ts";

export type Check = { status: "ok" | "warn" | "fail" | "skip"; area: string; detail: string };

/** The versions the bridge glue was checked against (docs/plan.md); anything else needs scripts/live-check.ts again. */
const PINNED = { "@earendil-works/pi-durable": "1.1.0", "pi-claude-bridge": "0.9.2" };

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** Each check resolves to one or more lines; none of them throws. */
export async function runChecks(loaded: Loaded): Promise<Check[]> {
	const { config } = loaded;
	const groups = [settings(loaded), node(), data(config), workspaces(config), versions(), claude(), model(config), app(config), push(), service()];
	return (await Promise.all(groups.map((group) => group.catch((error): Check[] => [{ status: "fail", area: "doctor", detail: message(error) }])))).flat();
}

async function settings({ config, errors }: Loaded): Promise<Check[]> {
	const source = config.file ?? "no settings file; the defaults";
	return [{ status: errors.length === 0 ? "ok" : "fail", area: "settings", detail: source }, ...errors.map((detail): Check => ({ status: "fail", area: "settings", detail }))];
}

async function node(): Promise<Check[]> {
	const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
	const ok = major > 22 || (major === 22 && minor >= 18);
	return [{ status: ok ? "ok" : "fail", area: "node", detail: ok ? `Node ${process.versions.node}` : `Node ${process.versions.node}; aludra needs 22.18 or later` }];
}

async function data(config: Config): Promise<Check[]> {
	try {
		mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
		accessSync(config.dataDir, constants.W_OK);
	} catch (error) {
		return [{ status: "fail", area: "data", detail: `${config.dataDir} isn't writable: ${message(error)}` }];
	}
	const running = await isListening(socketPathFor(config));
	return [
		{ status: "ok", area: "data", detail: config.dataDir },
		{ status: running ? "ok" : "warn", area: "host", detail: running ? "running" : "not running; start it with aludra serve" },
	];
}

async function workspaces(config: Config): Promise<Check[]> {
	return config.workspaces.flatMap((workspace) =>
		workspace.roots.map((root): Check => {
			const count = expandRoot(root).length;
			return { status: count > 0 ? "ok" : "warn", area: "workspaces", detail: `${workspace.name}: ${root} matches ${count} project${count === 1 ? "" : "s"}` };
		}));
}

async function versions(): Promise<Check[]> {
	return Object.entries(PINNED).map(([name, pinned]): Check => {
		const file = fileURLToPath(import.meta.resolve(`${name}/package.json`));
		const { version } = JSON.parse(readFileSync(file, "utf8")) as { version: string };
		return version === pinned
			? { status: "ok", area: "versions", detail: `${name} ${version}` }
			: { status: "fail", area: "versions", detail: `${name} is ${version}, but the bridge glue was checked against ${pinned}; rerun scripts/live-check.ts and update PINNED` };
	});
}

async function claude(): Promise<Check[]> {
	const result = spawnSync("claude", ["auth", "status", "--json"], { encoding: "utf8", timeout: 20_000 });
	if (result.error !== undefined) return [{ status: "fail", area: "claude", detail: `can't run claude: ${result.error.message}` }];
	try {
		const status = JSON.parse(result.stdout) as { loggedIn?: boolean; authMethod?: string; subscriptionType?: string };
		if (status.loggedIn !== true) return [{ status: "fail", area: "claude", detail: "Claude Code isn't logged in; run claude and /login" }];
		const subscription = status.authMethod === "claude.ai";
		return [{
			status: subscription ? "ok" : "warn",
			area: "claude",
			detail: subscription ? `logged in to a ${status.subscriptionType ?? "Claude"} subscription` : `logged in with ${status.authMethod}, not a subscription: runs would be billed`,
		}];
	} catch {
		return [{ status: "fail", area: "claude", detail: `claude auth status answered something else: ${(result.stdout || result.stderr).slice(0, 200)}` }];
	}
}

async function model(config: Config): Promise<Check[]> {
	if (config.model.provider === "faux") return [{ status: "warn", area: "model", detail: "the faux model: scripted answers, no network" }];
	const bridge = await loadBridge(() => {});
	const found = bridge.models.some((m) => m.id === config.model.id);
	return [{
		status: found ? "ok" : "fail",
		area: "model",
		detail: found ? `${PROVIDER}/${config.model.id}, thinking ${config.model.thinking}` : `the bridge has no ${config.model.id}; it has ${bridge.models.map((m) => m.id).join(", ")}`,
	}];
}

/** The app: its API needs a login to let in, the build to serve, and tailscale serve in front. */
async function app(config: Config): Promise<Check[]> {
	if (config.api.user === undefined) return [{ status: "warn", area: "app", detail: 'no api.user in the settings, so the app and its API are off; set it to your Tailscale login' }];
	const built = existsSync(join(APP_DIR, "_shell.html"));
	const checks: Check[] = [
		{ status: "ok", area: "app", detail: `API on 127.0.0.1:${config.api.port} for ${config.api.user}` },
		{ status: built ? "ok" : "fail", area: "app", detail: built ? "built" : "not built; run pnpm build" },
	];
	// aludra's own node (deploy/aludra-tailscale.service) if it's set up, else the machine's.
	const socket = join(homedir(), ".local/share/aludra/tailscale/tailscaled.sock");
	const own = existsSync(socket);
	const cli = (...args: string[]) => spawnSync("tailscale", [...(own ? ["--socket", socket] : []), ...args], { encoding: "utf8", timeout: 10_000 });
	const serve = cli("serve", "status", "--json");
	if (serve.error !== undefined) return [...checks, { status: "warn", area: "app", detail: "tailscale isn't installed, so the app has no way in" }];
	const served = serve.stdout.includes(`127.0.0.1:${config.api.port}`);
	let name = "";
	try {
		name = (JSON.parse(cli("status", "--json").stdout) as { Self?: { DNSName?: string } }).Self?.DNSName?.replace(/\.$/, "") ?? "";
	} catch {}
	const fix = own ? `tailscale --socket ${socket} serve --bg ${config.api.port}` : `tailscale serve --bg ${config.api.port}`;
	return [...checks, {
		status: served ? "ok" : "warn",
		area: "app",
		detail: served ? `https://${name}/ proxies to 127.0.0.1:${config.api.port}` : `tailscale serve isn't proxying to port ${config.api.port}; run: ${fix}`,
	}];
}

/** Web Push goes through the browser makers' push services, so the host has to reach them. */
async function push(): Promise<Check[]> {
	const services = ["web.push.apple.com", "fcm.googleapis.com"];
	const unreachable = (await Promise.all(services.map(async (host) => ((await fetch(`https://${host}/`, { signal: AbortSignal.timeout(10_000) }).then(() => true, () => false)) ? [] : [host])))).flat();
	if (unreachable.length > 0) return [{ status: "fail", area: "push", detail: `can't reach ${unreachable.join(" or ")}, so notifications to those devices won't arrive` }];
	return [{ status: "ok", area: "push", detail: "push services reachable; turn notifications on from the drawer in the app" }];
}

async function service(): Promise<Check[]> {
	const result = spawnSync("systemctl", ["--user", "is-active", "aludra.service"], { encoding: "utf8", timeout: 10_000 });
	const state = result.stdout.trim();
	if (state === "active") return [{ status: "ok", area: "service", detail: "aludra.service is active" }];
	return [{ status: "warn", area: "service", detail: `aludra.service is ${state || "not installed"}; deploy/aludra.service runs the host` }];
}

export function printChecks(checks: Check[]): number {
	const width = Math.max(...checks.map((c) => c.area.length));
	for (const check of checks) console.log(`${check.status.padEnd(4)}  ${check.area.padEnd(width)}  ${check.detail}`);
	const failed = checks.filter((c) => c.status === "fail").length;
	console.log(failed === 0 ? "\nNo problems found." : `\n${failed} problem${failed === 1 ? "" : "s"} found.`);
	return failed === 0 ? 0 : 1;
}
