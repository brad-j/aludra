// `aludra doctor`: checks the settings and everything the host depends on, without starting it and without spending
// anything (after gaidin's doctor.ts). Loading the bridge starts no Claude Code query.
import { spawnSync } from "node:child_process";
import { accessSync, constants, mkdirSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { listBackups } from "./backup.ts";
import { claudeExecutable, loadBridge, PROVIDER } from "./bridge.ts";
import { claudeConfigDir, type Config, type Loaded, type ProviderId } from "./config.ts";
import { accountModels, signInModels } from "./login.ts";
import { expandRoot } from "./projects.ts";
import { isListening, socketPathFor } from "./server.ts";
import { currentSpec, installedUnit, launchdPlist, lingers, platformOf, serviceState, systemdUnit, withoutPath } from "./service.ts";
import { servesPort, tailnetSelf, tailscaleFor } from "./tailscale.ts";

export type Check = { status: "ok" | "warn" | "fail" | "skip"; area: string; detail: string };

/** The versions the bridge glue was checked against (docs/plan.md); anything else needs scripts/live-check.ts again. */
const PINNED = { "@earendil-works/pi-durable": "1.3.0", "pi-claude-bridge": "0.9.3" };

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** Each check resolves to one or more lines; none of them throws. */
export async function runChecks(loaded: Loaded): Promise<Check[]> {
	const { config } = loaded;
	const groups = [settings(loaded), node(), data(config), workspaces(config), versions(), claude(config), model(config), openai(config), openrouter(config), api(config), push(), service(config), backups(config)];
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
		{ status: running ? "ok" : "warn", area: "host", detail: running ? "running" : "not running; run: aludra service install (or aludra serve)" },
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

/** Whether the settings offer any model of `provider`. */
const uses = (config: Config, provider: ProviderId) => config.model.choices.some((c) => c.provider === provider);

async function claude(config: Config): Promise<Check[]> {
	if (config.model.provider === "faux") return [{ status: "skip", area: "claude", detail: "not needed for the faux model" }];
	if (!uses(config, PROVIDER)) return [{ status: "skip", area: "claude", detail: "no Claude models in model.choices" }];
	let path: string;
	try {
		path = claudeExecutable(config.claude.path);
	} catch (error) {
		return [{ status: "fail", area: "claude", detail: message(error) }];
	}
	const result = spawnSync(path, ["auth", "status", "--json"], { encoding: "utf8", timeout: 20_000 });
	if (result.error !== undefined) return [{ status: "fail", area: "claude", detail: `can't run ${path}: ${result.error.message}` }];
	try {
		const status = JSON.parse(result.stdout) as { loggedIn?: boolean; authMethod?: string; subscriptionType?: string; email?: string };
		const dir = claudeConfigDir(config);
		if (status.loggedIn !== true) return [{ status: "fail", area: "claude", detail: `Claude Code isn't logged in at ${dir}; run CLAUDE_CONFIG_DIR=${dir} claude auth login` }];
		const subscription = status.authMethod === "claude.ai";
		return [{
			status: subscription ? "ok" : "warn",
			area: "claude",
			detail: subscription ? `${path}, logged in at ${dir}${status.email ? ` as ${status.email}` : ""} to a ${status.subscriptionType ?? "Claude"} subscription` : `logged in with ${status.authMethod}, not a subscription: runs would be billed`,
		}];
	} catch {
		return [{ status: "fail", area: "claude", detail: `claude auth status answered something else: ${(result.stdout || result.stderr).slice(0, 200)}` }];
	}
}

/** The default model is one its provider has (or the host won't start); a choice that isn't is left out of the picker. */
async function model(config: Config): Promise<Check[]> {
	if (config.model.provider === "faux") return [{ status: "warn", area: "model", detail: "the faux model: scripted answers, no network" }];
	const signIns = signInModels(config);
	const known: Partial<Record<ProviderId, string[]>> = { openai: signIns.getModels("openai").map((m) => m.id), openrouter: signIns.getModels("openrouter").map((m) => m.id) };
	if (uses(config, PROVIDER)) known[PROVIDER] = (await loadBridge({ claudePath: config.claude.path, dir: join(config.dataDir, "bridge") }, () => {})).models.map((m) => m.id);
	const has = (provider: ProviderId, id: string) => known[provider]?.includes(id) === true;
	const { provider, id } = config.model;
	const checks: Check[] = [has(provider, id)
		? { status: "ok", area: "model", detail: `${provider}/${id}, thinking ${config.model.thinking}` }
		: { status: "fail", area: "model", detail: `${provider} has no ${id}; it has ${known[provider]?.join(", ") || "none"}` }];
	for (const choice of config.model.choices) {
		if (!has(choice.provider, choice.id)) checks.push({ status: "warn", area: "model", detail: `${choice.provider} has no ${choice.id}, so the apps leave it out` });
	}
	return checks;
}

/** OpenRouter, when a model is pinned or the machine is signed in: billed per request, so say so. */
async function openrouter(config: Config): Promise<Check[]> {
	if (config.model.provider === "faux") return [];
	const auth = await signInModels(config).checkAuth("openrouter");
	if (auth === undefined) return uses(config, "openrouter") ? [{ status: "fail", area: "openrouter", detail: "not signed in, so OpenRouter's models fail; run: aludra login openrouter" }] : [];
	return [{ status: "ok", area: "openrouter", detail: `signed in (${auth.type === "oauth" ? "aludra's own key" : auth.source ?? "an API key"}); every request is billed, and each session shows its cost` }];
}

/** OpenAI, when the settings offer its models: signed in with ChatGPT, and each one in the account's catalog. */
async function openai(config: Config): Promise<Check[]> {
	if (config.model.provider === "faux" || !uses(config, "openai")) return [];
	const models = signInModels(config);
	const auth = await models.checkAuth("openai");
	if (auth === undefined) return [{ status: "fail", area: "openai", detail: "not signed in, so OpenAI's models fail; run: aludra login openai" }];
	if (auth.type === "api_key") return [{ status: "warn", area: "openai", detail: `no ChatGPT sign-in, so requests use ${auth.source ?? "an API key"} and are billed per token; to use your plan, run: aludra login openai` }];
	const checks: Check[] = [{ status: "ok", area: "openai", detail: "signed in with ChatGPT; requests use your plan" }];
	try {
		const offered = new Set((await accountModels(models)).runnable.map((m) => m.id));
		for (const choice of config.model.choices.filter((c) => c.provider === "openai" && !offered.has(c.id))) {
			checks.push({ status: "warn", area: "openai", detail: `your ChatGPT account doesn't offer ${choice.id}; aludra login openai lists what it does` });
		}
	} catch (error) {
		checks.push({ status: "warn", area: "openai", detail: `couldn't list the account's models: ${message(error)}` });
	}
	return checks;
}

/** The API: it needs a login to let in, and tailscale serve in front. */
async function api(config: Config): Promise<Check[]> {
	if (config.api.users.length === 0) return [{ status: "warn", area: "api", detail: 'no api.users in the settings, so the API is off; list your Tailscale login: "users": ["you@example.com"]' }];
	const checks: Check[] = [{ status: "ok", area: "api", detail: `API on 127.0.0.1:${config.api.port} for ${config.api.users.join(", ")}` }];
	const tailscale = tailscaleFor(config);
	const serve = tailscale.run("serve", "status", "--json");
	const fix = tailscale.command("serve", "--bg", String(config.api.port));
	if (serve === undefined) return [...checks, { status: "warn", area: "api", detail: "tailscale isn't installed, so the API has no way in; install it from tailscale.com" }];
	const self = tailnetSelf(tailscale);
	if (self === undefined) return [...checks, { status: "warn", area: "api", detail: `tailscale isn't logged in; run: ${tailscale.command("up")}` }];
	if (!servesPort(serve.stdout, config.api.port)) return [...checks, { status: "warn", area: "api", detail: `tailscale serve isn't sending anything to port ${config.api.port}; run: ${fix}` }];
	return [
		...checks,
		{ status: "ok", area: "api", detail: `https://${self.dnsName}/api is the API; the Mac app adds wss://${self.dnsName}/amyrlin` },
	];
}

async function backups(config: Config): Promise<Check[]> {
	const newest = listBackups(config.backup.dir)[0];
	const where = config.backup.dir.startsWith(config.dataDir) ? "beside the database; set backup.dir to another disk or a synced folder to keep copies off this one" : config.backup.dir;
	if (newest === undefined) return [{ status: "warn", area: "backup", detail: `none yet; the running host makes one within the hour, or run: aludra backup (${where})` }];
	const hours = (Date.now() - newest.at.getTime()) / 3_600_000;
	const age = hours < 1 ? "under an hour" : hours < 48 ? `${Math.round(hours)} hours` : `${Math.round(hours / 24)} days`;
	const late = hours > config.backup.everyHours * 2;
	return [{ status: late ? "warn" : "ok", area: "backup", detail: `newest ${age} old${late ? ", later than it should be; is the host running?" : ""}; ${where}` }];
}

async function push(): Promise<Check[]> {
	const services = ["web.push.apple.com", "fcm.googleapis.com"];
	const unreachable = (await Promise.all(services.map(async (host) => ((await fetch(`https://${host}/`, { signal: AbortSignal.timeout(10_000) }).then(() => true, () => false)) ? [] : [host])))).flat();
	if (unreachable.length > 0) return [{ status: "fail", area: "push", detail: `can't reach ${unreachable.join(" or ")}, so notifications to those devices won't arrive` }];
	return [{ status: "ok", area: "push", detail: "push services reachable; a device signs up through /api/push/subscribe" }];
}

async function service(config: Config): Promise<Check[]> {
	const platform = platformOf();
	if (platform === undefined) return [{ status: "skip", area: "service", detail: `no service on ${process.platform}; run the host with aludra serve` }];
	const state = serviceState(platform);
	if (!state.installed) return [{ status: "warn", area: "service", detail: "not installed, so the host runs only while aludra serve does; run: aludra service install" }];
	const checks: Check[] = [{ status: state.running ? "ok" : "warn", area: "service", detail: state.running ? state.detail : `${state.detail}; run: aludra service install` }];
	// After an upgrade or a switch of Node, the unit may still name the old paths. Its PATH is the installing shell's.
	const current = platform === "launchd" ? launchdPlist(currentSpec(config)) : systemdUnit(currentSpec(config));
	const installed = installedUnit(platform);
	if (installed === undefined || withoutPath(installed) !== withoutPath(current)) checks.push({ status: "warn", area: "service", detail: "the service runs a different aludra, Node or settings file than this one; run: aludra service install" });
	if (platform === "systemd" && !lingers()) checks.push({ status: "warn", area: "service", detail: `the host stops when you log out; run: loginctl enable-linger ${userInfo().username}` });
	return checks;
}

export function printChecks(checks: Check[]): number {
	const width = Math.max(...checks.map((c) => c.area.length));
	for (const check of checks) console.log(`${check.status.padEnd(4)}  ${check.area.padEnd(width)}  ${check.detail}`);
	const failed = checks.filter((c) => c.status === "fail").length;
	console.log(failed === 0 ? "\nNo problems found." : `\n${failed} problem${failed === 1 ? "" : "s"} found.`);
	return failed === 0 ? 0 : 1;
}
