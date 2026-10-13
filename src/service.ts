// `aludra service`: runs the host in the background and at login, as a launchd agent on macOS and a systemd user unit
// on Linux. The unit runs this Node and this aludra with the PATH of the shell that installed it, since sessions run
// their commands with the host's environment, and git, pnpm and Claude Code are found through it. Installing again
// rewrites the unit and restarts the host, so a reinstall after an upgrade or a Node switch picks up the new paths.
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { findExecutable } from "./bridge.ts";
import { type Config, defaultConfigFile } from "./config.ts";

/** What the unit runs. */
export type ServiceSpec = {
	/** The unit's name: `aludra`, so `aludra.service` and `io.bradjohnson.aludra`. */
	name: string;
	node: string;
	main: string;
	/** A settings file to pass with --config; none for the default one. */
	config?: string;
	path: string;
	home: string;
};

export type ServiceState = { installed: boolean; running: boolean; detail: string };

export type Platform = "launchd" | "systemd";

export const platformOf = (platform: NodeJS.Platform = process.platform): Platform | undefined =>
	platform === "darwin" ? "launchd" : platform === "linux" ? "systemd" : undefined;

const label = (name: string) => `io.bradjohnson.${name}`;

export function unitFile(platform: Platform, name: string, env: NodeJS.ProcessEnv = process.env): string {
	return platform === "launchd"
		? join(homedir(), "Library", "LaunchAgents", `${label(name)}.plist`)
		: join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "systemd", "user", `${name}.service`);
}

export const logFile = (name: string) => join(homedir(), "Library", "Logs", "aludra", `${name}.log`);

/** The spec for the aludra running now, with `config`'s settings file and Claude Code on the PATH. */
export function currentSpec(config: Config, name = "aludra", env: NodeJS.ProcessEnv = process.env): ServiceSpec {
	const main = realpathSync(process.argv[1]!);
	const dirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
	// Node's and Claude Code's directories, wherever the shell had them, so the unit finds both.
	const claude = findExecutable(config.claude.path, env);
	for (const dir of [dirname(process.execPath), ...(claude === undefined ? [] : [dirname(claude)])]) if (!dirs.includes(dir)) dirs.push(dir);
	const custom = config.file !== undefined && config.file !== defaultConfigFile(env) ? config.file : undefined;
	return { name, node: process.execPath, main, ...(custom === undefined ? {} : { config: custom }), path: dirs.join(delimiter), home: homedir() };
}

const args = (spec: ServiceSpec) => [spec.node, "--no-warnings", spec.main, ...(spec.config === undefined ? [] : ["--config", spec.config]), "serve"];

const xml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function launchdPlist(spec: ServiceSpec): string {
	const string = (value: string) => `<string>${xml(value)}</string>`;
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Written by aludra service install. Install again to change it. -->
<plist version="1.0">
<dict>
	<key>Label</key>
	${string(label(spec.name))}
	<key>ProgramArguments</key>
	<array>
${args(spec).map((a) => `\t\t${string(a)}`).join("\n")}
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		${string(spec.path)}
	</dict>
	<key>WorkingDirectory</key>
	${string(spec.home)}
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>Umask</key>
	<integer>63</integer>
	<key>StandardOutPath</key>
	${string(logFile(spec.name))}
	<key>StandardErrorPath</key>
	${string(logFile(spec.name))}
</dict>
</plist>
`;
}

export function systemdUnit(spec: ServiceSpec): string {
	// systemd splits ExecStart on spaces and reads % and $ as specifiers; quoted words keep spaces.
	const word = (value: string) => {
		const escaped = value.replace(/%/g, "%%").replace(/\$/g, "$$$$");
		return /[\s"\\]/.test(escaped) ? `"${escaped.replace(/["\\]/g, "\\$&")}"` : escaped;
	};
	return `# Written by aludra service install. Install again to change it.
[Unit]
Description=aludra coding agent host

[Service]
ExecStart=${args(spec).map(word).join(" ")}
WorkingDirectory=${word(spec.home)}
Environment=${word(`PATH=${spec.path}`)}
Restart=always
RestartSec=5
UMask=0077

[Install]
WantedBy=default.target
`;
}

type Run = (command: string, args: string[]) => { ok: boolean; stdout: string; stderr: string; missing: boolean };

const run: Run = (command, args) => {
	const result = spawnSync(command, args, { encoding: "utf8", timeout: 30_000 });
	return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: (result.stderr ?? "").trim(), missing: result.error !== undefined };
};

const domain = () => `gui/${userInfo().uid}`;

export function serviceState(platform: Platform, name = "aludra"): ServiceState {
	const installed = lstatExists(unitFile(platform, name));
	if (platform === "launchd") {
		const printed = run("launchctl", ["print", `${domain()}/${label(name)}`]);
		if (!printed.ok) return { installed, running: false, detail: installed ? `${label(name)} is installed but not loaded` : "not installed" };
		const pid = /^\s*pid = (\d+)/m.exec(printed.stdout)?.[1];
		return { installed, running: pid !== undefined, detail: pid === undefined ? `${label(name)} is loaded but not running` : `${label(name)} is running (pid ${pid})` };
	}
	const active = run("systemctl", ["--user", "is-active", `${name}.service`]);
	if (active.missing) return { installed, running: false, detail: "no systemd here" };
	const state = active.stdout.trim() || "unknown";
	return { installed, running: state === "active", detail: installed ? `${name}.service is ${state}` : "not installed" };
}

/** Writes the unit and (re)starts the host. Returns what happened, a line each. */
export function installService(platform: Platform, spec: ServiceSpec): string[] {
	const file = unitFile(platform, spec.name);
	const lines: string[] = [];
	if (platform === "launchd") {
		mkdirSync(dirname(logFile(spec.name)), { recursive: true });
		writeUnit(file, launchdPlist(spec));
		lines.push(`wrote ${file}`);
		const target = `${domain()}/${label(spec.name)}`;
		if (run("launchctl", ["print", target]).ok) {
			must(run("launchctl", ["bootout", target]), "launchctl bootout");
			// bootout returns before launchd has let go of the job; bootstrapping before then fails with error 5.
			waitUntil(() => !run("launchctl", ["print", target]).ok, 10_000);
		}
		let started = run("launchctl", ["bootstrap", domain(), file]);
		for (let attempt = 1; !started.ok && attempt < 5; attempt++) {
			sleepSync(1000);
			started = run("launchctl", ["bootstrap", domain(), file]);
		}
		must(started, "launchctl bootstrap");
		lines.push(`started ${label(spec.name)}; its log is ${logFile(spec.name)}`);
		return lines;
	}
	writeUnit(file, systemdUnit(spec));
	lines.push(`wrote ${file}`);
	must(run("systemctl", ["--user", "daemon-reload"]), "systemctl --user daemon-reload");
	must(run("systemctl", ["--user", "enable", `${spec.name}.service`]), "systemctl --user enable");
	must(run("systemctl", ["--user", "restart", `${spec.name}.service`]), "systemctl --user restart");
	lines.push(`started ${spec.name}.service; journalctl --user -u ${spec.name} shows its log`);
	if (!lingers()) lines.push(`it stops when you log out; to keep it running, run: loginctl enable-linger ${userInfo().username}`);
	return lines;
}

export function uninstallService(platform: Platform, name = "aludra"): string[] {
	const file = unitFile(platform, name);
	if (platform === "launchd") {
		const target = `${domain()}/${label(name)}`;
		if (run("launchctl", ["print", target]).ok) must(run("launchctl", ["bootout", target]), "launchctl bootout");
	} else {
		run("systemctl", ["--user", "disable", "--now", `${name}.service`]);
	}
	if (!lstatExists(file)) return ["no service was installed"];
	unlinkSync(file);
	if (platform === "systemd") run("systemctl", ["--user", "daemon-reload"]);
	return [`stopped the host and removed ${file}`];
}

/** Whether the user's systemd manager outlives their sessions, which a host that runs while nobody's logged in needs. */
export function lingers(): boolean {
	return run("loginctl", ["show-user", userInfo().username, "--property=Linger", "--value"]).stdout.trim() === "yes";
}

/** A unit's text without its PATH, which differs from shell to shell without the unit being out of date. */
export function withoutPath(unit: string): string {
	return unit.replace(/(<key>PATH<\/key>\s*<string>)[^<]*(<\/string>)/, "$1$2").replace(/^Environment=.*PATH=.*$/m, "");
}

/** The unit's file as installed, for comparing with what would be written now. */
export function installedUnit(platform: Platform, name = "aludra"): string | undefined {
	const file = unitFile(platform, name);
	return existsSync(file) ? readFileSync(file, "utf8") : undefined;
}

/** Writes a unit file. An older setup linked the unit from a checkout, and a pull can leave the link dangling; writing
 * through it would change or recreate the checkout's file, so a link is replaced by a file. */
export function writeUnit(file: string, text: string) {
	mkdirSync(dirname(file), { recursive: true });
	// unlinkSync, since rmSync leaves a dangling link in place without an error.
	if (lstatExists(file) && lstatSync(file).isSymbolicLink()) unlinkSync(file);
	writeFileSync(file, text);
}

function lstatExists(file: string): boolean {
	try {
		lstatSync(file);
		return true;
	} catch {
		return false;
	}
}

function sleepSync(ms: number) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Polls `done` every 100 ms until it holds or `timeout` ms pass. */
function waitUntil(done: () => boolean, timeout: number) {
	const deadline = Date.now() + timeout;
	while (!done() && Date.now() < deadline) sleepSync(100);
}

function must(result: ReturnType<Run>, what: string) {
	if (!result.ok) throw new Error(`${what} failed${result.stderr ? `: ${result.stderr}` : ""}`);
}
