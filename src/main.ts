#!/usr/bin/env -S node --no-warnings
// The aludra command.
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { backupNow } from "./backup.ts";
import { talk } from "./cli.ts";
import { expandHome, loadConfig } from "./config.ts";
import { printChecks, runChecks } from "./doctor.ts";
import { findProjects } from "./projects.ts";
import { isListening, serve, socketPathFor } from "./server.ts";
import { currentSpec, installService, platformOf, serviceState, uninstallService } from "./service.ts";
import { login, logout } from "./login.ts";
import { init } from "./setup.ts";
import { runTui } from "./tui.ts";

const USAGE = `usage: aludra [--config FILE] [COMMAND]

  (none) [--session ID]                  open the terminal UI: every session and its transcript, read-only

  init [--root PATTERN]... [--user LOGIN]... [--name NAME] [--yes] [--force]
                                         write the settings file, asking for what isn't given
  service install | uninstall | status   run the host in the background and at login (launchd or systemd)
  serve                                  run the host: sessions, the bridge, the socket the CLI uses
  ask --project NAME "MESSAGE"           start a session in a project and print its run
  ask --session ID [--steer] "MESSAGE"   send a session a follow-up (or a steer) and print the run
  watch [--session ID]                   print what every session (or one) does, until Ctrl+C
  sessions                               list sessions by project, with their state
  stop --session ID                      stop a session's run
  retitle                                have a model title sessions that still have their first line
  approvals                              list calls waiting for approval
  approve ID | deny ID                   answer one
  projects                               list the projects the workspaces' roots match
  backup                                 copy the database into the backup directory now
  login openai | openrouter              sign in with ChatGPT (OpenAI on your plan) or to OpenRouter (billed per request)
  logout openai | openrouter             forget that sign-in on this machine
  doctor                                 check the settings and everything the host needs

--id REQUEST with ask makes it safe to retry: the same id finds the same message rather than sending it twice.
Settings come from --config, ALUDRA_CONFIG or ~/.config/aludra/config.json ($XDG_CONFIG_HOME); aludra init writes one.`;

const { values, positionals } = parseArgs({
	options: {
		config: { type: "string" },
		project: { type: "string", short: "p" },
		session: { type: "string", short: "s" },
		steer: { type: "boolean" },
		id: { type: "string" },
		root: { type: "string", multiple: true },
		user: { type: "string", multiple: true },
		name: { type: "string" },
		yes: { type: "boolean", short: "y" },
		force: { type: "boolean" },
		help: { type: "boolean", short: "h" },
	},
	allowPositionals: true,
});
const [command, ...rest] = positionals;
// With no command in a terminal, the terminal UI; piped, or asked for help, the usage.
const interactive = command === undefined && !values.help && process.stdout.isTTY && process.stdin.isTTY;
if (values.help || command === "help" || (command === undefined && !interactive)) {
	console.log(USAGE);
	process.exit(command === undefined && !values.help ? 2 : 0);
}

const loaded = loadConfig(values.config);
const { config } = loaded;
function fail(...lines: string[]): never {
	for (const line of lines) console.error(line);
	process.exit(1);
}
function sessionId(): number {
	const id = Number(values.session);
	if (values.session === undefined || !Number.isInteger(id)) fail(`aludra ${command} needs --session ID (aludra sessions lists them)`);
	return id;
}

switch (command) {
	case undefined: {
		const session = values.session === undefined ? undefined : sessionId();
		process.exit(await runTui(config, session === undefined ? {} : { session }));
	}
	case "init":
		try {
			const file = values.config ?? process.env.ALUDRA_CONFIG;
			const lines = await init(config, {
				...(file === undefined ? {} : { file: resolve(expandHome(file)) }),
				...(values.root === undefined ? {} : { roots: values.root }),
				...(values.user === undefined ? {} : { users: values.user }),
				...(values.name === undefined ? {} : { name: values.name }),
				yes: values.yes === true,
				force: values.force === true,
			});
			console.log(lines.join("\n"));
		} catch (error) {
			fail(`aludra init: ${error instanceof Error ? error.message : String(error)}`);
		}
		process.exit(0);
	case "service": {
		const platform = platformOf();
		if (platform === undefined) fail(`aludra service runs on macOS (launchd) and Linux (systemd), not ${process.platform}; run aludra serve instead`);
		const action = rest[0];
		try {
			if (action === "install") {
				if (loaded.errors.length > 0) fail("aludra can't start; fix these settings first:", ...loaded.errors.map((e) => `  ${e}`));
				if (!serviceState(platform).running && (await isListening(socketPathFor(config)))) {
					fail("an aludra serve is already running outside the service; stop it (Ctrl+C where it runs), then install");
				}
				console.log(installService(platform, currentSpec(config)).join("\n"));
			} else if (action === "uninstall") {
				console.log(uninstallService(platform).join("\n"));
			} else if (action === "status") {
				// 0 running, 1 installed but not running, 3 not installed.
				const state = serviceState(platform);
				console.log(state.detail);
				process.exit(state.running ? 0 : state.installed ? 1 : 3);
			} else {
				fail("usage: aludra service install | uninstall | status");
			}
		} catch (error) {
			fail(`aludra service ${action}: ${error instanceof Error ? error.message : String(error)}`);
		}
		process.exit(0);
	}
	case "serve":
		if (loaded.errors.length > 0) fail("aludra can't start; fix these settings:", ...loaded.errors.map((e) => `  ${e}`));
		await serve(config);
		break;
	case "ask": {
		const content = rest.join(" ");
		if (content === "") fail('usage: aludra ask --project NAME "MESSAGE"   or   aludra ask --session ID "MESSAGE"');
		if ((values.project === undefined) === (values.session === undefined)) fail("aludra ask needs --project or --session, not both");
		const requestId = values.id ?? randomUUID();
		const target = values.project === undefined ? { session: sessionId() } : { project: values.project };
		const again = values.session === undefined ? "aludra watch follows it" : `rerun with --id ${requestId} to reattach`;
		process.exit(await talk(config, { type: "ask", content, requestId, steer: values.steer === true, ...target }, `lost the server before the answer. The run is stored; ${again}.`));
	}
	case "watch":
		process.exit(await talk(config, values.session === undefined ? { type: "watch" } : { type: "watch", session: sessionId() }));
	case "sessions":
		process.exit(await talk(config, { type: "sessions", listing: true }));
	case "stop":
		process.exit(await talk(config, { type: "stop", session: sessionId() }));
	case "approvals":
		process.exit(await talk(config, { type: "approvals" }));
	case "retitle":
		process.exit(await talk(config, { type: "retitle" }));
	case "approve":
	case "deny":
		if (rest[0] === undefined) fail(`usage: aludra ${command} ID (aludra approvals lists them)`);
		process.exit(await talk(config, { type: "decide", id: rest[0], allow: command === "approve" }));
	case "projects":
		for (const project of findProjects(config.workspaces)) console.log(`${project.name.padEnd(24)} ${project.workspace.padEnd(8)} ${project.dir}`);
		process.exit(0);
	case "backup":
		try {
			console.log(`wrote ${await backupNow(config)}`);
		} catch (error) {
			fail(`aludra backup: ${error instanceof Error ? error.message : String(error)}`);
		}
		process.exit(0);
	case "login":
	case "logout":
		try {
			console.log((await (command === "login" ? login : logout)(config, rest[0])).join("\n"));
		} catch (error) {
			fail(`aludra ${command}: ${error instanceof Error ? error.message : String(error)}`);
		}
		process.exit(0);
	case "doctor":
		process.exit(printChecks(await runChecks(loaded)));
	default:
		fail(`unknown command ${command}`, "", USAGE);
}
