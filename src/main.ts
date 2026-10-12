#!/usr/bin/env -S node --no-warnings
// The aludra command.
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { talk } from "./cli.ts";
import { loadConfig } from "./config.ts";
import { printChecks, runChecks } from "./doctor.ts";
import { findProjects } from "./projects.ts";
import { serve } from "./server.ts";

const USAGE = `usage: aludra [--config FILE] COMMAND

  serve                                  run the host: sessions, the bridge, the socket the CLI uses
  ask --project NAME "MESSAGE"           start a session in a project and print its run
  ask --session ID [--steer] "MESSAGE"   send a session a follow-up (or a steer) and print the run
  watch [--session ID]                   print what every session (or one) does, until Ctrl+C
  sessions                               list sessions by project, with their state
  stop --session ID                      stop a session's run
  approvals                              list calls waiting for approval
  approve ID | deny ID                   answer one
  projects                               list the projects the workspaces' roots match
  doctor                                 check the settings and everything the host needs

--id REQUEST with ask makes it safe to retry: the same id finds the same message rather than sending it twice.
Settings come from --config, ALUDRA_CONFIG or aludra.json beside package.json; without one, the defaults.`;

const { values, positionals } = parseArgs({
	options: {
		config: { type: "string" },
		project: { type: "string", short: "p" },
		session: { type: "string", short: "s" },
		steer: { type: "boolean" },
		id: { type: "string" },
		help: { type: "boolean", short: "h" },
	},
	allowPositionals: true,
});
const [command, ...rest] = positionals;
if (values.help || command === undefined || command === "help") {
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
		process.exit(await talk(config, { type: "sessions" }));
	case "stop":
		process.exit(await talk(config, { type: "stop", session: sessionId() }));
	case "approvals":
		process.exit(await talk(config, { type: "approvals" }));
	case "approve":
	case "deny":
		if (rest[0] === undefined) fail(`usage: aludra ${command} ID (aludra approvals lists them)`);
		process.exit(await talk(config, { type: "decide", id: rest[0], allow: command === "approve" }));
	case "projects":
		for (const project of findProjects(config.workspaces)) console.log(`${project.name.padEnd(24)} ${project.workspace.padEnd(8)} ${project.dir}`);
		process.exit(0);
	case "doctor":
		process.exit(printChecks(await runChecks(loaded)));
	default:
		fail(`unknown command ${command}`, "", USAGE);
}
