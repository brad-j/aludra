// The settings: one JSON file, checked at start. Everything but the workspaces has a default.
//
//   {
//     "workspaces": [{ "name": "code", "roots": ["~/code/*", "~/work/*/*"] }],
//     "model": { "id": "claude-opus-5-5", "thinking": "high", "choices": ["claude-opus-5-5", "openai/gpt-6.1-sol"] },
//     "claude": { "path": "claude", "configDir": "~/.claude-personal" },
//     "approvals": { "hosts": ["prod-db", "router"], "waitHours": 24 },
//     "backup": { "dir": "/mnt/nas/aludra", "everyHours": 24, "keep": 7 },
//     "api": { "port": 8724, "users": ["you@example.com"] },
//     "dataDir": "~/.local/share/aludra"
//   }
//
// The file is --config, else ALUDRA_CONFIG, else config.json in aludra's settings directory ($XDG_CONFIG_HOME/aludra,
// or ~/.config/aludra). ALUDRA_MODEL=faux runs a scripted model with no network, and ALUDRA_DATA_DIR replaces the
// data directory, which is ~/Library/Application Support/aludra on macOS and $XDG_DATA_HOME/aludra (or
// ~/.local/share/aludra) elsewhere.
//
// `api.users` are the Tailscale logins the app's API and the amyrlin endpoint let in (src/api.ts); without any, the API
// doesn't start, since every request would be refused. Everyone listed sees and runs every session. `model.choices`
// are the models the app offers, each `provider/id` or a bare ID of `model.provider` (claude-bridge unless set); so is
// `model.id`. OpenAI's models run on the ChatGPT sign-in `aludra login openai` keeps, OpenRouter's on the key `aludra login openrouter` gets (src/login.ts). `claude.path` is the Claude Code that runs Claude's models, the user's own install
// and login; a bare name is looked up on PATH. `claude.configDir` is the CLAUDE_CONFIG_DIR the host sets for itself at
// start (src/main.ts) and Claude Code inherits, which picks the login. `backup` copies the database while the host runs (src/backup.ts); its directory is
// backups/ in the data directory unless it names another disk or a synced folder.
//
// The apps and `aludra config` change most settings while the host runs (src/settings.ts), so the host reads them from
// its Config each time rather than keeping copies.
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { array, integer, isObject, type Json, literal, number, object, optional, ParseError, parseJson, string } from "./parse.ts";

export const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type Thinking = (typeof THINKING)[number];

export type Workspace = { name: string; roots: string[] };

/** The model providers: Claude Code through pi-claude-code, OpenAI on a ChatGPT sign-in, OpenRouter, and the scripted faux model. */
export const PROVIDERS = ["claude-bridge", "openai", "openrouter", "faux"] as const;
export type ProviderId = (typeof PROVIDERS)[number];
export type ModelSetting = { provider: ProviderId; id: string };

export type Config = {
	/** The file the settings came from, if any. */
	file?: string;
	workspaces: Workspace[];
	model: { provider: ProviderId; id: string; thinking: Thinking; choices: ModelSetting[] };
	/** The Claude Code binary Claude's models run through, and the config directory (so the login) it uses when the settings name one. */
	claude: { path: string; configDir?: string };
	/** The app's API on loopback; tailscale serve is the way in. */
	api: { port: number; users: string[] };
	/** Calls that wait for the user: `git push`, and ssh, scp, rsync or sftp naming one of `hosts`. */
	approvals: { hosts: string[]; waitHours: number };
	/** Copies of the database: one every `everyHours`, the newest `keep` kept, in `dir`. */
	backup: { dir: string; everyHours: number; keep: number };
	dataDir: string;
};

export type Loaded = { config: Config; errors: string[] };

/** aludra's own directory, where package.json is: the parent of src/ when run from source, of dist/host/ when built. */
export const PACKAGE_DIR = ((): string => {
	for (let dir = import.meta.dirname; dir !== dirname(dir); dir = dirname(dir)) {
		if (existsSync(join(dir, "package.json"))) return dir;
	}
	throw new Error(`no package.json above ${import.meta.dirname}`);
})();

/** `~` and `~/...` as paths in the home directory. */
export function expandHome(path: string): string {
	if (path === "~") return homedir();
	return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

/** Where the settings file is when none is named. */
export function defaultConfigFile(env: NodeJS.ProcessEnv = process.env): string {
	return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "aludra", "config.json");
}

/** Where the database, keys and scratch directories go when the settings don't say. */
export function defaultDataDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
	if (platform === "darwin") return join(homedir(), "Library", "Application Support", "aludra");
	return join(env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "aludra");
}

const DEFAULTS = {
	model: { provider: "claude-bridge", id: "claude-opus-5-5", thinking: "high", choices: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"].map((id) => ({ provider: "claude-bridge" as const, id })) },
	claude: { path: "claude" },
	api: { port: 8724, users: [] },
	approvals: { hosts: [], waitHours: 24 },
	backup: { everyHours: 24, keep: 7 },
} satisfies Omit<Config, "workspaces" | "dataDir" | "backup"> & { backup: Omit<Config["backup"], "dir"> };

const EXAMPLE_WORKSPACE = '"workspaces": [{ "name": "code", "roots": ["~/code/*"] }]';

const settingsFile = object({
	workspaces: optional(array(object({ name: string, roots: array(string) }))),
	model: optional(object({ provider: optional(literal(...PROVIDERS)), id: optional(string), thinking: optional(literal(...THINKING)), choices: optional(array(string)) })),
	claude: optional(object({ path: optional(string), configDir: optional(string) })),
	api: optional(object({ port: optional(integer), users: optional(array(string)) })),
	approvals: optional(object({ hosts: optional(array(string)), waitHours: optional(number) })),
	backup: optional(object({ dir: optional(string), everyHours: optional(number), keep: optional(integer) })),
	dataDir: optional(string),
});

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/** The directory Claude Code keeps its login and session files in: the settings' `claude.configDir`, else
 * CLAUDE_CONFIG_DIR, else ~/.claude. */
export function claudeConfigDir(config: Config, env: NodeJS.ProcessEnv = process.env): string {
	return config.claude.configDir ?? (env.CLAUDE_CONFIG_DIR ? resolve(expandHome(env.CLAUDE_CONFIG_DIR)) : join(homedir(), ".claude"));
}

/** `provider/id`, or a bare ID of `fallback`. Model IDs may hold slashes; only a known provider before the first one counts. */
function modelSetting(text: string, fallback: ProviderId, errors: string[]): ModelSetting {
	const slash = text.indexOf("/");
	if (slash === -1) return { provider: fallback, id: text };
	const provider = text.slice(0, slash);
	if (!(PROVIDERS as readonly string[]).includes(provider)) errors.push(`model ${text} names no provider aludra has; it has ${PROVIDERS.filter((p) => p !== "faux").join(" and ")}`);
	// SAFETY: checked just above; an unknown one is an error, so the host never starts with it.
	return { provider: provider as ProviderId, id: text.slice(slash + 1) };
}

/** The settings from `text` over the defaults, with the environment on top. */
export function configFor(text?: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Loaded {
	const errors: string[] = [];
	let file: ReturnType<typeof settingsFile> = {};
	if (text !== undefined) {
		try {
			file = parseJson(text, settingsFile, "the settings");
			// Unnamed fields are ignored, so the old single login would quietly turn the API off.
			const raw = JSON.parse(text) as Json;
			if (isObject(raw) && isObject(raw.api) && "user" in raw.api) errors.push('api.user is now api.users, a list: "users": ["you@example.com"]');
		} catch (error) {
			if (!(error instanceof ParseError)) throw error;
			errors.push(error.message);
		}
	}
	const config: Config = {
		workspaces: file.workspaces ?? [],
		model: { ...DEFAULTS.model, thinking: file.model?.thinking ?? DEFAULTS.model.thinking },
		claude: {
			path: expandHome(file.claude?.path ?? DEFAULTS.claude.path),
			...(file.claude?.configDir ? { configDir: resolve(expandHome(file.claude.configDir)) } : {}),
		},
		api: { ...DEFAULTS.api, ...file.api },
		approvals: { ...DEFAULTS.approvals, ...file.approvals },
		dataDir: expandHome(env.ALUDRA_DATA_DIR ?? file.dataDir ?? defaultDataDir(env, platform)),
		backup: { ...DEFAULTS.backup, dir: "" },
	};
	const { dir, ...backup } = file.backup ?? {};
	config.backup = { ...DEFAULTS.backup, ...backup, dir: dir === undefined ? join(config.dataDir, "backups") : resolve(expandHome(dir)) };
	const fallback = file.model?.provider ?? DEFAULTS.model.provider;
	const chosen = modelSetting(file.model?.id ?? DEFAULTS.model.id, fallback, errors);
	if (file.model?.provider !== undefined && chosen.provider !== file.model.provider) errors.push(`model.id ${file.model.id} isn't a ${file.model.provider} model, as model.provider says`);
	config.model.provider = chosen.provider;
	config.model.id = chosen.id;
	if (file.model?.choices !== undefined) config.model.choices = file.model.choices.map((choice) => modelSetting(choice, fallback, errors));
	if (env.ALUDRA_MODEL === "faux") config.model = { ...config.model, provider: "faux", id: "faux-1", choices: [{ provider: "faux", id: "faux-1" }] };
	const { provider, id } = config.model;
	if (!config.model.choices.some((c) => c.provider === provider && c.id === id)) config.model.choices = [{ provider, id }, ...config.model.choices];
	// The apps pick a model by its ID.
	const ids = config.model.choices.map((c) => c.id);
	const twice = ids.find((choice, i) => ids.indexOf(choice) !== i);
	if (twice !== undefined) errors.push(`two of model.choices are ${twice}; the apps pick models by ID, so keep one`);
	const names = config.workspaces.map((w) => w.name);
	if (new Set(names).size !== names.length) errors.push("two workspaces share a name");
	if (config.workspaces.length === 0) errors.push(`no workspaces: name the folders that hold your projects, such as ${EXAMPLE_WORKSPACE}`);
	if (config.claude.configDir !== undefined && !isDirectory(config.claude.configDir)) errors.push(`claude.configDir ${config.claude.configDir} isn't a directory; log in there with CLAUDE_CONFIG_DIR=${config.claude.configDir} claude auth login`);
	if (!(config.approvals.waitHours > 0)) errors.push("approvals.waitHours should be more than 0");
	if (config.api.port < 1 || config.api.port > 65535) errors.push("api.port should be a port number");
	if (!(config.backup.everyHours > 0)) errors.push("backup.everyHours should be more than 0");
	if (config.backup.keep < 1) errors.push("backup.keep should be 1 or more");
	return { config, errors };
}

/** The settings from the file `--config` names, ALUDRA_CONFIG, or the default file. */
export function loadConfig(path?: string, env: NodeJS.ProcessEnv = process.env): Loaded {
	const named = path ?? env.ALUDRA_CONFIG;
	const file = named === undefined ? defaultConfigFile(env) : resolve(expandHome(named));
	if (!existsSync(file)) {
		const loaded = configFor(undefined, env);
		loaded.errors.unshift(`no settings file at ${file}`);
		return loaded;
	}
	const loaded = configFor(readFileSync(file, "utf8"), env);
	loaded.config.file = file;
	return loaded;
}
