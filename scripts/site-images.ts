// The picture on aludra-site's home page, made from aludra itself with sample sessions and a scripted model:
// `aludra sessions` as HTML. Rerun after its layout changes:
//
//   node --no-warnings scripts/site-images.ts ../aludra-site
//
// It writes src/generated/sessions.html there. The sample projects live in ~/code for the run, so their
// paths read as ~/code/...; it stops if ~/code already exists rather than touch it.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { type FauxResponseStep, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { configFor } from "../src/config.ts";
import { context, openHost } from "../src/host.ts";
import { renderSessions } from "../src/listing.ts";
import { readSummary } from "../src/live.ts";

const site = resolve(process.argv[2] ?? "../aludra-site");
const code = join(homedir(), "code");
if (existsSync(code)) throw new Error(`${code} exists; this script makes its sample projects there and removes them after, so it won't run`);
const data = mkdtempSync(join(tmpdir(), "aludra-site-images-"));

const ANSWER = [
	"The suite fails in `test/session.test.ts`: it expects the old cookie name, `sid`, which the login change on Tuesday renamed to `session`.",
	"",
	"| Test | Result |",
	"| --- | --- |",
	"| unit | 1 failed, 212 passed |",
	"| e2e | passed |",
	"",
	"The fix is one line in the test:",
	"",
	"```ts",
	"expect(cookie.name).toBe(\"session\");",
	"```",
	"",
	"Want me to make it and rerun the suite?",
].join("\n");

/** What the scripted model says, by the first message of the session asking. */
const SCRIPTS: Record<string, ReturnType<typeof fauxAssistantMessage>[]> = {
	"Why does the test suite fail on main?": [
		fauxAssistantMessage([fauxToolCall("bash", { command: "git log --oneline -3" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxToolCall("read", { path: "README.md" })], { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxText(ANSWER)),
	],
	"Summarize what changed in the docs this week": [fauxAssistantMessage(fauxText("Two pages changed: setup now covers Linux services, and the API reference lists the new `/search` endpoint."))],
	"Run the full build and tell me what breaks": [fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 120" })], { stopReason: "toolUse" })],
	"Push the release branch": [fauxAssistantMessage([fauxToolCall("bash", { command: "git push origin release" })], { stopReason: "toolUse" })],
};
const asked = new Map<string, number>();
const faux = fauxProvider({ provider: "claude-bridge", models: [{ id: "claude-opus-5-5", name: "Claude Opus 5.5", contextWindow: 1_000_000 }], tokensPerSecond: 2000 });
faux.setResponses(Array.from({ length: 50 }, () => (ctx: { messages: readonly { role: string; content?: unknown }[] }) => {
	const first = JSON.stringify(ctx.messages.find((m) => m.role === "user")?.content);
	const prompt = Object.keys(SCRIPTS).find((p) => first.includes(p))!;
	const step = asked.get(prompt) ?? 0;
	asked.set(prompt, step + 1);
	return SCRIPTS[prompt]![step]!;
}) as FauxResponseStep[]);
const models = createModels();
models.setProvider(faux.provider);

const git = (dir: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=you", "-c", "user.email=you@example.com", ...args], { cwd: dir });
function project(name: string) {
	const dir = join(code, name);
	mkdirSync(dir, { recursive: true });
	git(dir, "init", "-q", "-b", "main");
	writeFileSync(join(dir, "README.md"), `# ${name}\n`);
	git(dir, "add", "-A");
	git(dir, "commit", "-qm", "Start");
	writeFileSync(join(dir, "NOTES.md"), "Login sets a session cookie.\n");
	git(dir, "add", "-A");
	git(dir, "commit", "-qm", "Rename the session cookie");
	return { workspace: "devbox", name, path: name, dir };
}

const { config } = configFor(JSON.stringify({ dataDir: data, workspaces: [{ name: "devbox", roots: ["~/code/*"] }] }), {});
let close = async () => {};
try {
	// Names whose colors are cool, so the project headings aren't brown.
	const projects = { backend: project("backend"), shop: project("shop"), docs: project("docs") };
	const host = await openHost({ config, models, model: { provider: "claude-bridge", modelId: "claude-opus-5-5" }, agentDir: join(data, "agent"), onNotice: () => {} });
	host.resume();
	close = async () => {
		for (const s of await host.sessions.list()) await host.stop(s.id).catch(() => {});
		await host.close();
	};
	const start = async (where: keyof typeof projects, prompt: string, wait = true) => {
		const session = await host.sessions.create(projects[where], prompt);
		const submission = await host.submit(session.id, prompt);
		if (wait) await submission.wait(context);
		return session;
	};
	await start("docs", "Summarize what changed in the docs this week");
	await start("backend", "Why does the test suite fail on main?");
	await start("shop", "Run the full build and tell me what breaks", false);
	await start("shop", "Push the release branch", false);
	await new Promise((done) => setTimeout(done, 1500));

	// `aludra sessions` on a terminal of a fixed width, in 24-bit color, as HTML.
	const sessions = (await Promise.all((await host.sessions.list()).map((s) => readSummary(host, s.id)))).flatMap((s) => (s === undefined ? [] : [s]));
	const frame = ["$ aludra sessions", ...renderSessions(sessions, await host.colors.list(), { depth: 24, width: 96 })];
	mkdirSync(join(site, "src", "generated"), { recursive: true });
	writeFileSync(join(site, "src", "generated", "sessions.html"), `<!-- Made by aludra's scripts/site-images.ts; don't edit. -->\n${frame.map(ansiToHtml).join("\n")}\n`);
	console.log(`wrote ${join(site, "src/generated/sessions.html")}`);
} finally {
	await close();
	rmSync(code, { recursive: true, force: true });
	rmSync(data, { recursive: true, force: true });
}
process.exit(0);

/** One line of the terminal's output as HTML: its 24-bit colors, bold and italic as spans; other sequences dropped. */
function ansiToHtml(line: string): string {
	let out = "";
	let style: { fg?: string; bg?: string; bold?: boolean; italic?: boolean; underline?: boolean } = {};
	const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
	// eslint-disable-next-line no-control-regex
	for (const part of line.split(/(\x1b\[[0-9;]*m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b_[^\x1b]*\x1b\\)/)) {
		if (part === "" || part.startsWith("\x1b]") || part.startsWith("\x1b_")) continue;
		// eslint-disable-next-line no-control-regex
		const sgr = /^\x1b\[([0-9;]*)m$/.exec(part);
		if (sgr === null) {
			const css = [style.fg && `color:${style.fg}`, style.bg && `background:${style.bg}`, style.bold && "font-weight:600", style.italic && "font-style:italic", style.underline && "text-decoration:underline"].filter(Boolean).join(";");
			out += css === "" ? escape(part) : `<span style="${css}">${escape(part)}</span>`;
			continue;
		}
		const codes = (sgr[1] || "0").split(";").map(Number);
		for (let i = 0; i < codes.length; i++) {
			const c = codes[i];
			if (c === 0) style = {};
			else if (c === 1) style.bold = true;
			else if (c === 22) style.bold = false;
			else if (c === 3) style.italic = true;
			else if (c === 23) style.italic = false;
			else if (c === 4) style.underline = true;
			else if (c === 24) style.underline = false;
			else if (c === 39) style.fg = undefined;
			else if (c === 49) style.bg = undefined;
			else if ((c === 38 || c === 48) && codes[i + 1] === 2) {
				const rgb = `rgb(${codes.slice(i + 2, i + 5).join(" ")})`;
				if (c === 38) style.fg = rgb;
				else style.bg = rgb;
				i += 4;
			}
		}
	}
	return out;
}
