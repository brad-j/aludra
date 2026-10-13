import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { configFor } from "../src/config.ts";
import { launchdPlist, type ServiceSpec, systemdUnit } from "../src/service.ts";
import { findRepositories, settingsText, suggestRoots } from "../src/setup.ts";
import { parseStatus, servesPort } from "../src/tailscale.ts";
import { tempDir } from "./helpers.ts";

test("init guesses roots from where repositories are, folding sibling folders into one root", (t) => {
	const home = tempDir(t);
	const repos = ["code/a", "code/b", "work/Projects/Software/x", "work/Projects/Software/y", "work/Projects/Tools/z", "lone/only", "Library/hidden-from-us/r", "code/a/nested"];
	for (const repo of repos) mkdirSync(join(home, repo, ".git"), { recursive: true });
	mkdirSync(join(home, ".cache", "c", ".git"), { recursive: true });
	mkdirSync(join(home, "notes", "plain"), { recursive: true });

	const found = findRepositories(home).map((r) => r.slice(home.length + 1));
	assert.deepEqual(found, ["code/a", "code/b", "lone/only", "work/Projects/Software/x", "work/Projects/Software/y", "work/Projects/Tools/z"], "not inside a repository, Library or hidden folders");
	assert.deepEqual(suggestRoots(home, findRepositories(home)), ["~/work/Projects/*/*", "~/code/*"], "a folder with one repository isn't a root");
});

test("init writes settings that load without errors", () => {
	const text = settingsText({ name: "mac", roots: ["~/code/*"], users: ["you@example.com"] });
	const { config, errors } = configFor(text, {});
	assert.deepEqual(errors, []);
	assert.deepEqual(config.workspaces, [{ name: "mac", roots: ["~/code/*"] }]);
	assert.deepEqual(config.api.users, ["you@example.com"]);
});

const spec: ServiceSpec = { name: "aludra", node: "/opt/node 24/bin/node", main: "/lib/aludra/dist/host/main.js", config: "/etc/a&b.json", path: "/usr/bin:/opt/node 24/bin", home: "/home/you" };

test("the launchd agent runs this Node and aludra with the PATH, and is a valid property list", (t) => {
	const plist = launchdPlist(spec);
	assert.match(plist, /<string>io\.bradjohnson\.aludra<\/string>/);
	assert.match(plist, /<string>\/opt\/node 24\/bin\/node<\/string>\s*<string>--no-warnings<\/string>\s*<string>\/lib\/aludra\/dist\/host\/main.js<\/string>\s*<string>--config<\/string>\s*<string>\/etc\/a&amp;b.json<\/string>\s*<string>serve<\/string>/);
	assert.match(plist, /<key>PATH<\/key>\s*<string>\/usr\/bin:\/opt\/node 24\/bin<\/string>/);
	if (process.platform === "darwin") {
		const file = join(tempDir(t), "agent.plist");
		writeFileSync(file, plist);
		const lint = spawnSync("plutil", ["-lint", file], { encoding: "utf8" });
		assert.equal(lint.status, 0, lint.stdout + lint.stderr);
	}
});

test("the systemd unit quotes paths with spaces and escapes what systemd would expand", () => {
	const unit = systemdUnit({ ...spec, config: "/etc/100%$x.json" });
	assert.match(unit, /^ExecStart="\/opt\/node 24\/bin\/node" --no-warnings \/lib\/aludra\/dist\/host\/main.js --config \/etc\/100%%\$\$x.json serve$/m);
	assert.match(unit, /^Environment="PATH=\/usr\/bin:\/opt\/node 24\/bin"$/m);
	assert.doesNotMatch(systemdUnit({ name: "aludra", node: "/n", main: "/m", path: "/p", home: "/h" }), /--config/);
});

test("Tailscale's status gives this node's name and its owner's login; serve status says what's served", () => {
	const status = JSON.stringify({ Self: { DNSName: "mac.tail1.ts.net.", UserID: 42 }, User: { "42": { LoginName: "you@example.com" }, "7": { LoginName: "other@example.com" } } });
	assert.deepEqual(parseStatus(status), { dnsName: "mac.tail1.ts.net", login: "you@example.com" });
	assert.deepEqual(parseStatus(JSON.stringify({ Self: { DNSName: "tagged.tail1.ts.net." } })), { dnsName: "tagged.tail1.ts.net" });
	assert.equal(parseStatus("not json"), undefined);
	const serve = JSON.stringify({ Web: { "mac.tail1.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:8724" } } } } });
	assert.equal(servesPort(serve, 8724), true);
	assert.equal(servesPort(serve, 8725), false);
	assert.equal(servesPort("{}", 8724), false);
});
