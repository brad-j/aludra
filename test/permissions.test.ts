import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { configFor } from "../src/config.ts";
import { context, openHost } from "../src/host.ts";
import { approvalFor, protectedTarget } from "../src/permissions.ts";
import { makeProject, tempDir, testHost } from "./helpers.ts";

test("git push and remote commands to homelab hosts need approval; other commands don't", () => {
	const hosts = ["think-1", "think-2", "monitor-01"];
	for (const command of ["git push", "git push origin main", "cd x && git -C ../y push --force", "/usr/bin/git --no-pager push", "pnpm test; git push", "jj git push"]) {
		assert.equal(approvalFor(command, hosts), "git push", command);
	}
	assert.equal(approvalFor("ssh think-1 'qm list'", hosts), "ssh to think-1");
	assert.equal(approvalFor("ssh -i key root@think-2.half.black uptime", hosts), "ssh to think-2");
	assert.equal(approvalFor("rsync -av dist/ monitor-01:/srv/site", hosts), "rsync to monitor-01");
	assert.equal(approvalFor("scp notes.txt think-1:", hosts), "scp to think-1");
	for (const command of ["git status", "git commit -m 'push the fix'", "git log --grep push", "ssh github.com", "echo think-1", "pnpm push-docs", "ssh-keygen -l"]) {
		assert.equal(approvalFor(command, hosts), undefined, command);
	}
});

test("the protected-path gate blocks credential files and keys, as terminal pi's does", () => {
	const cwd = "/home/brad/westwood/Projects/Software/aludra";
	assert.match(protectedTarget("read", { path: ".env" }, cwd)!, /environment or credential file/);
	assert.match(protectedTarget("edit", { path: "~/.ssh/config" }, cwd)!, /private key material/);
	assert.match(protectedTarget("write", { path: "/home/brad/.pi/agent/auth.json" }, cwd)!, /agent authentication/);
	assert.match(protectedTarget("bash", { command: "cat .npmrc" }, cwd)!, /credential/);
	assert.match(protectedTarget("read", {}, cwd)!, /invalid path/);
	assert.equal(protectedTarget("read", { path: "src/main.ts" }, cwd), undefined);
	assert.equal(protectedTarget("bash", { command: "curl https://example.com/key.pem" }, cwd), undefined);
});

/** A faux model that runs `command` once, then answers with the tool's result. */
function oneCommand(command: string) {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	faux.setResponses(Array.from({ length: 20 }, () => (ctx: TranscriptContext) => {
		const last = ctx.messages.at(-1);
		if (last?.role === "toolResult") return fauxAssistantMessage(fauxText(`result: ${JSON.stringify(last.content)}`));
		return fauxAssistantMessage(fauxToolCall("bash", { command }), { stopReason: "toolUse" });
	}));
	const models = createModels();
	models.setProvider(faux.provider);
	return { models, model: { provider: "faux", modelId: "faux-1" } };
}

const lastText = async (host: Awaited<ReturnType<typeof testHost>>["host"], id: number) =>
	JSON.stringify((await (await host.conversation(id)).context(context)).messages.at(-1));

async function pendingFor(host: Awaited<ReturnType<typeof testHost>>["host"], id: number) {
	for (;;) {
		const found = (await host.approvals.pending()).find((r) => r.conversationId === id);
		if (found !== undefined) return found;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

test("a git push waits for approval, and runs once Brad approves", async (t) => {
	const { host, dir } = await testHost(t, oneCommand("echo pushing; git push --dry-run"));
	const session = await host.sessions.create(makeProject(dir, "one"), "push it");
	const run = await host.submit(session.id, "push it");
	const request = await pendingFor(host, session.id);
	assert.equal(request.summary, "git push");
	assert.equal((await host.sessions.states()).get(session.id), "waiting");
	assert.equal((await host.approvals.decide(request.id, true))?.status, "approved");
	assert.equal((await run.wait(context)).status, "done");
	assert.match(await lastText(host, session.id), /pushing/);
});

test("a denied ssh to a homelab host is blocked, and the model hears why", async (t) => {
	const { host, dir } = await testHost(t, oneCommand("ssh think-1 'qm list'"));
	const session = await host.sessions.create(makeProject(dir, "one"), "check vms");
	const run = await host.submit(session.id, "check vms");
	const request = await pendingFor(host, session.id);
	assert.equal(request.summary, "ssh to think-1");
	await host.approvals.decide(request.id, false);
	await run.wait(context);
	assert.match(await lastText(host, session.id), /Needs Brad's approval \(ssh to think-1\), and Brad said no/);
});

test("a new message instead of an answer refuses the waiting call and runs", async (t) => {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	faux.setResponses([fauxAssistantMessage(fauxToolCall("bash", { command: "git push" }), { stopReason: "toolUse" }), fauxAssistantMessage("not pushed"), fauxAssistantMessage("leaving it")]);
	const models = createModels();
	models.setProvider(faux.provider);
	const { host, dir } = await testHost(t, { models, model: { provider: "faux", modelId: "faux-1" } });
	const session = await host.sessions.create(makeProject(dir, "one"), "push");
	const first = await host.submit(session.id, "push");
	await pendingFor(host, session.id);
	const second = await host.submit(session.id, "actually, don't");
	assert.deepEqual([(await first.wait(context)).status, (await second.wait(context)).status], ["done", "done"]);
	assert.deepEqual((await host.approvals.all()).map((r) => r.status), ["superseded"]);
	assert.match(await lastText(host, session.id), /leaving it/);
});

test("an approval survives a restart: the call waits on the same request, and runs once approved", async (t) => {
	const dir = tempDir(t);
	const project = makeProject(dir, "one");
	const { config } = configFor(JSON.stringify({ dataDir: join(dir, "data"), workspaces: [{ name: "test", roots: [join(dir, "Projects/*/*")] }] }), {});
	const first = await openHost({ config, ...oneCommand("echo pushed && git push"), agentDir: join(dir, "agent") });
	first.resume();
	const session = await first.sessions.create(project, "push");
	const run = await first.submit(session.id, "push", { requestId: "push-1" });
	const request = await pendingFor(first, session.id);
	await first.close();

	const second = await openHost({ config, ...oneCommand("echo pushed && git push"), agentDir: join(dir, "agent") });
	t.after(() => second.close());
	second.resume();
	const again = await pendingFor(second, session.id);
	assert.equal(again.id, request.id);
	await second.approvals.decide(again.id, true);
	const settled = await (await second.harness.submission(run.id, context))!.wait(context);
	assert.equal(settled.status, "done");
	assert.match(await lastText(second, session.id), /pushed/);
});

test("a protected path is blocked; a second block in one run stops it", async (t) => {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("read", { path: ".env" }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("bash", { command: "cat .env.local" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("never reached"),
	]);
	const models = createModels();
	models.setProvider(faux.provider);
	const { host, dir } = await testHost(t, { models, model: { provider: "faux", modelId: "faux-1" } });
	const session = await host.sessions.create(makeProject(dir, "one", { ".env": "TOKEN=x" }), "secrets");
	await (await host.submit(session.id, "read the env")).wait(context);
	const results = (await (await host.conversation(session.id)).context(context)).messages.filter((m) => m.role === "toolResult");
	assert.equal(results.length, 2);
	assert.match(JSON.stringify(results[0]), /Protected-path gate blocked read target \\".env\\".*Do not retry/);
	assert.match(JSON.stringify(results[1]), /Second block this run; stopping/);
	assert.equal(faux.getPendingResponseCount(), 1, "the model wasn't asked again");
});
