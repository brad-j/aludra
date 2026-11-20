import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { expandSkill, projectSkills, skillsFor } from "../src/context.ts";
import { context } from "../src/host.ts";
import { fakeSandboxes, gitProject, makeProject, SANDBOX_SETTINGS, tempDir, testHost } from "./helpers.ts";

const skill = (name: string, description: string, body = `${name}'s steps.`) => `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

/** `deepen` and `recraft` in the agent directory; `ship-notes` and a `deepen` that loses to the user's in the project. */
function writeSkills(agentDir: string, projectDir: string) {
	for (const [name, text] of [["deepen", skill("deepen", "Work out what an expert would do.")], ["recraft", skill("recraft", "Make images.")]] as const) {
		mkdirSync(join(agentDir, "skills", name), { recursive: true });
		writeFileSync(join(agentDir, "skills", name, "SKILL.md"), text);
	}
	mkdirSync(join(agentDir, "skills", "recraft", "refs"), { recursive: true });
	writeFileSync(join(agentDir, "skills", "recraft", "refs", "styles.md"), "styles\n");
	mkdirSync(join(projectDir, ".pi", "skills", "ship-notes"), { recursive: true });
	writeFileSync(join(projectDir, ".pi", "skills", "ship-notes", "SKILL.md"), skill("ship-notes", "Write ship notes.", "Ship notes go in NOTES.md."));
	mkdirSync(join(projectDir, ".pi", "skills", "deepen"), { recursive: true });
	writeFileSync(join(projectDir, ".pi", "skills", "deepen", "SKILL.md"), skill("deepen", "The project's own deepen."));
}

/** A host with a faux model that records each request's system prompt and last user message, and fake sandboxes. */
async function skillsHost(t: TestContext) {
	const root = tempDir(t);
	const { project } = gitProject(root, "one");
	const fake = fakeSandboxes(join(root, "fake"));
	t.after(() => fake.close());
	const seen: { system: string; user: string }[] = [];
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	faux.setResponses(Array.from({ length: 20 }, () => (ctx: TranscriptContext) => {
		seen.push({ system: JSON.stringify(ctx.messages.filter((m) => m.role === "system")), user: JSON.stringify(ctx.messages.findLast((m) => m.role === "user")?.content ?? "") });
		return fauxAssistantMessage(fauxText("ok"));
	}));
	const models = createModels();
	models.setProvider(faux.provider);
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeSkills(agentDir, project.dir);
	const { host } = await testHost(t, { dir: root, sandboxes: fake.sandboxes, settings: SANDBOX_SETTINGS, models, model: { provider: "faux", modelId: "faux-1" }, agentDir });
	return { host, fake, project, agentDir, seen, root };
}

test("skillsFor lists the user's skills, then the project's, with a project skill named like a user skill left out", (t) => {
	const root = tempDir(t);
	const agentDir = join(root, "agent");
	const project = makeProject(root, "one");
	writeSkills(agentDir, project.dir);
	assert.deepEqual(skillsFor(project.dir, agentDir).map((s) => [s.name, s.source]), [["deepen", "user"], ["recraft", "user"], ["ship-notes", "project"]]);
	assert.deepEqual(skillsFor(undefined, agentDir).map((s) => s.name), ["deepen", "recraft"]);
	const user = skillsFor(undefined, agentDir);
	assert.deepEqual(projectSkills(project.dir, user, agentDir).map((s) => s.name), ["ship-notes"]);
	assert.deepEqual(projectSkills(join(root, "nowhere"), user, agentDir), []);
});

test("a sandbox gets copies of the user's and the project's skills, and its prompt names them at their paths in the sandbox", async (t) => {
	const { host, fake, project, agentDir, seen } = await skillsHost(t);
	const session = await host.sessions.createSandbox(project, "hello");
	const record = (await host.sessions.get(session.id))!;
	const home = fake.sandboxes.home(record.sandbox!);
	assert.deepEqual(record.sandboxSkills?.map((s) => [s.name, s.filePath]), [
		["deepen", `${home}/.pi/agent/skills/deepen/SKILL.md`],
		["recraft", `${home}/.pi/agent/skills/recraft/SKILL.md`],
		["ship-notes", `${home}/.aludra/project-skills/ship-notes/SKILL.md`],
	]);
	// The files are there, references beside them, and the project's copy is outside the repository.
	assert.match(readFileSync(`${home}/.aludra/project-skills/ship-notes/SKILL.md`, "utf8"), /Ship notes go in NOTES.md/);
	assert.ok(existsSync(`${home}/.pi/agent/skills/recraft/refs/styles.md`));
	assert.ok(!record.sandboxSkills!.some((s) => s.filePath.startsWith(record.dir)));

	await (await host.submit(session.id, "hi")).wait(context);
	const system = seen.at(-1)!.system;
	assert.match(system, new RegExp(`<location>${home}/.pi/agent/skills/deepen/SKILL.md</location>`));
	assert.match(system, new RegExp(`<location>${home}/.aludra/project-skills/ship-notes/SKILL.md</location>`));
	assert.ok(!system.includes(agentDir), "no host path in a sandbox prompt");
	assert.ok(!system.includes(join(project.dir, ".pi")), "no project path on the host either");
});

test("a link in the skills directory that leads nowhere doesn't stop the other skills being copied", async (t) => {
	const { host, fake, project, agentDir } = await skillsHost(t);
	// A skill whose repository moved: the link stays and points at nothing, which tar -h used to stop at.
	symlinkSync(join(agentDir, "..", "moved", "skills", "gone"), join(agentDir, "skills", "gone"));
	mkdirSync(join(agentDir, "skills", "notes"), { recursive: true });
	writeFileSync(join(agentDir, "skills", "notes", "README.md"), "not a skill\n");
	const session = await host.sessions.createSandbox(project, "hello");
	const record = (await host.sessions.get(session.id))!;
	const home = fake.sandboxes.home(record.sandbox!);
	assert.deepEqual(record.sandboxSkills?.map((s) => s.name), ["deepen", "recraft", "ship-notes"]);
	assert.ok(existsSync(`${home}/.pi/agent/skills/recraft/refs/styles.md`));
	assert.ok(!existsSync(`${home}/.pi/agent/skills/notes`), "only the skills' own directories are copied");
});

test("a sandbox whose skills couldn't be copied is ready with none in its prompt", async (t) => {
	const { host, project, seen } = await skillsHost(t);
	// Over the cap: the copy fails, and the sandbox is made anyway.
	writeFileSync(join(project.dir, ".pi", "skills", "ship-notes", "big.bin"), Buffer.alloc(21 * 1024 * 1024));
	const session = await host.sessions.createSandbox(project, "hello");
	const record = (await host.sessions.get(session.id))!;
	assert.equal(record.sandboxState, "ready");
	assert.deepEqual(record.sandboxSkills, []);
	await (await host.submit(session.id, "hi")).wait(context);
	assert.doesNotMatch(seen.at(-1)!.system, /available_skills/);
});

test("/skill:name is expanded from the skills the session can load, here and in a sandbox", async (t) => {
	const { host, fake, project, agentDir, seen } = await skillsHost(t);
	// Here: the file on this machine, by its path here.
	const local = await host.sessions.create(project, "local");
	await (await host.submit(local.id, "/skill:ship-notes for the 1.2 release")).wait(context);
	const here = JSON.parse(seen.at(-1)!.user) as string | { text: string }[];
	const hereText = typeof here === "string" ? here : here.map((b) => b.text).join("");
	assert.equal(hereText, `<skill name="ship-notes" location="${join(project.dir, ".pi", "skills", "ship-notes", "SKILL.md")}">\nReferences are relative to ${join(project.dir, ".pi", "skills", "ship-notes")}.\n\nShip notes go in NOTES.md.\n</skill>\n\nfor the 1.2 release`);

	// In a sandbox: its copy, read there, so an edit here since it was made doesn't reach it.
	const boxed = await host.sessions.createSandbox(project, "boxed");
	const home = fake.sandboxes.home((await host.sessions.get(boxed.id))!.sandbox!);
	writeFileSync(join(agentDir, "skills", "deepen", "SKILL.md"), skill("deepen", "Changed here.", "Changed after the sandbox was made."));
	await (await host.submit(boxed.id, "/skill:deepen")).wait(context);
	const there = seen.at(-1)!.user;
	assert.match(there, new RegExp(`<skill name=\\\\"deepen\\\\" location=\\\\"${home}/.pi/agent/skills/deepen/SKILL.md\\\\">`));
	assert.match(there, /deepen's steps\./);
	assert.doesNotMatch(there, /Changed after/);

	// An unknown name goes as it was typed.
	await (await host.submit(boxed.id, "/skill:nope please")).wait(context);
	assert.match(seen.at(-1)!.user, /\/skill:nope please/);
});

test("expandSkill leaves text alone when it isn't a skill command or the file can't be read", async () => {
	const list = [{ name: "a", description: "A", filePath: "/x/a/SKILL.md", baseDir: "/x/a", source: "user" as const }];
	assert.equal(await expandSkill("hello /skill:a", list, async () => "body"), "hello /skill:a");
	assert.equal(await expandSkill("/skill:a", list, async () => undefined), "/skill:a");
	assert.equal(await expandSkill("/skill:a\nmore", list, async () => "---\nname: a\n---\nbody"), `<skill name="a" location="/x/a/SKILL.md">\nReferences are relative to /x/a.\n\nbody\n</skill>\n\nmore`);
});

test("Claude Code's skills come after the agent directory's, lose a clash to them, and beat the project's", (t) => {
	const root = tempDir(t);
	const agentDir = join(root, "agent");
	const claude = join(root, "claude", "skills");
	const project = makeProject(root, "one");
	writeSkills(agentDir, project.dir);
	for (const [name, text] of [["humanizer", skill("humanizer", "Edit prose.")], ["recraft", skill("recraft", "Claude Code's recraft.")], ["ship-notes", skill("ship-notes", "Claude Code's ship notes.")]] as const) {
		mkdirSync(join(claude, name), { recursive: true });
		writeFileSync(join(claude, name, "SKILL.md"), text);
	}
	const all = skillsFor(project.dir, agentDir, [claude]);
	assert.deepEqual(all.map((s) => [s.name, s.source]), [["deepen", "user"], ["recraft", "user"], ["humanizer", "user"], ["ship-notes", "user"]]);
	assert.equal(all.find((s) => s.name === "recraft")!.description, "Make images.");
	const user = skillsFor(undefined, agentDir, [claude]);
	assert.deepEqual(user.map((s) => s.name), ["deepen", "recraft", "humanizer", "ship-notes"]);
	assert.deepEqual(projectSkills(project.dir, user, agentDir), []);
	// A directory that isn't there is skipped.
	assert.deepEqual(skillsFor(project.dir, agentDir, [join(root, "nowhere")]).map((s) => s.name), ["deepen", "recraft", "ship-notes"]);
});

test("a sandbox gets Claude Code's skills in its ~/.claude/skills, and /skill: expands them here and there", async (t) => {
	const { host, fake, project, seen, root } = await skillsHost(t);
	// testHost points Claude Code's skills at <root>/claude/skills.
	const claudeDir = join(root, "claude", "skills");
	mkdirSync(join(claudeDir, "humanizer"), { recursive: true });
	writeFileSync(join(claudeDir, "humanizer", "SKILL.md"), skill("humanizer", "Edit prose.", "Cut the filler."));
	assert.ok(host.skills.user().some((s) => s.name === "humanizer"), "host.info lists it");

	const local = await host.sessions.create(project, "local");
	await (await host.submit(local.id, "/skill:humanizer the README")).wait(context);
	assert.match(seen.at(-1)!.user, /Cut the filler\./);

	const session = await host.sessions.createSandbox(project, "hello");
	const record = (await host.sessions.get(session.id))!;
	const home = fake.sandboxes.home(record.sandbox!);
	assert.deepEqual(record.sandboxSkills?.map((s) => [s.name, s.filePath]), [
		["deepen", `${home}/.pi/agent/skills/deepen/SKILL.md`],
		["recraft", `${home}/.pi/agent/skills/recraft/SKILL.md`],
		["humanizer", `${home}/.claude/skills/humanizer/SKILL.md`],
		["ship-notes", `${home}/.aludra/project-skills/ship-notes/SKILL.md`],
	]);
	await (await host.submit(session.id, "/skill:humanizer")).wait(context);
	assert.match(seen.at(-1)!.user, new RegExp(`${home}/.claude/skills/humanizer/SKILL.md`));
	assert.match(seen.at(-1)!.user, /Cut the filler\./);
});
