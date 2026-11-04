// Screenshots for a sandbox session's result (amyrlin's protocol section 10 item 19): the pages a project's dev server
// serves, before (at the commit the sandbox was made from) and after (at HEAD), taken in the sandbox once a run ends
// with an answer. They're opt-in: the project declares its dev server and pages in `.agents/project.json`, and its
// `.agents/setup` installs Chromium for its own Playwright. Without either, there are none, and nothing says so.
//
// Each side runs in a worktree of its own in the sandbox, so the agent's files (and anything its dev server would
// generate in them) stay as they were. The worktree gets the project's node_modules as hard links, or for the before
// side installs afresh when the work changed the dependencies. The PNGs come back to `shots/<session>/` in the data
// directory, swept with uploads after the same days.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";

export type Shot = { id: string; label: string; side: "before" | "after"; path?: string };
export type DevServer = { command: string; port: number };
export type Page = { path: string; label?: string };

/** Most pages shot on each side, declared ones first. */
export const MAX_PAGES = 6;
/** How long one side may take, from making its worktree to stopping its server, in seconds. */
export const SIDE_TIMEOUT_S = 6 * 60;
/** How long the dev server has to answer on its port, in seconds. */
export const SERVER_WAIT_S = 120;

const SCRIPT_EXTENSIONS = /\.(?:tsx|ts|jsx|js|mjs)$/;

/**
 * The page paths the changed `files` make, for the file-based routers that name pages by path: TanStack Router and
 * Remix (`routes/`), SvelteKit (`+page`), Astro (`src/pages/`) and Next's app router (`app/…/page`). Dynamic routes are
 * left out, since there's no telling what to fill them with, and so are layouts and the root, which "/" covers.
 */
export function routesFromFiles(files: readonly string[]): string[] {
	const found = new Set<string>();
	const add = (segments: string[]) => {
		const kept = segments.filter((s) => s !== "" && !/^\(.*\)$/.test(s));
		if (kept.some((s) => s.startsWith("$") || s.includes("[") || s.startsWith("@"))) return;
		found.add(`/${kept.join("/")}`);
	};
	for (const file of files) {
		if (/(?:^|\/)node_modules\//.test(file) || /\.(?:test|spec)\.\w+$/.test(file)) continue;
		const svelte = /(?:^|\/)src\/routes\/(?:(.*)\/)?\+page(?:\.server)?\.(?:svelte|ts|js)$/.exec(file);
		if (svelte !== null) {
			add((svelte[1] ?? "").split("/"));
			continue;
		}
		const next = /(?:^|\/)(?:src\/)?app\/(?:(.*)\/)?page\.(?:tsx|jsx|ts|js|mdx)$/.exec(file);
		if (next !== null) {
			add((next[1] ?? "").split("/"));
			continue;
		}
		const astro = /(?:^|\/)src\/pages\/(.+)\.(?:astro|md|mdx|html)$/.exec(file);
		if (astro !== null) {
			const segments = astro[1]!.split("/");
			if (segments.some((s) => s.startsWith("_"))) continue;
			if (segments.at(-1) === "index") segments.pop();
			add(segments);
			continue;
		}
		const routes = /(?:^|\/)(?:src\/|app\/)*routes\/(.+)$/.exec(file);
		if (routes === null || !SCRIPT_EXTENSIONS.test(routes[1]!) || /(?:^|\/)\+/.test(routes[1]!)) continue;
		// Flat route names split at dots as directories split at slashes: posts.index.tsx is posts/index.tsx.
		const segments = routes[1]!.replace(SCRIPT_EXTENSIONS, "").split(/[/.]/);
		if (segments.some((s) => s.startsWith("-") || s === "__root" || s === "routeTree")) continue;
		add(segments.filter((s) => s !== "index" && s !== "route" && s !== "_index" && !s.startsWith("_")).map((s) => s.replace(/_$/, "")));
	}
	return [...found];
}

/** The pages to shoot: the declared ones, then the turn's changed routes, without repeats, at most MAX_PAGES. */
export function pagesToShoot(declared: readonly Page[], changed: readonly string[]): Page[] {
	const pages: Page[] = [];
	const seen = new Set<string>();
	for (const page of [...declared, ...changed.map((path) => ({ path }))]) {
		if (seen.has(page.path) || pages.length >= MAX_PAGES) continue;
		seen.add(page.path);
		pages.push(page);
	}
	return pages;
}

/**
 * Run with node in the sandbox. `probe DIR` says `ok` when the project's own Playwright loads from DIR and its Chromium
 * is installed, or `none: why`. `shoot DIR BASE PAGES OUT` shoots each page of the PAGES file at BASE into OUT, a JSON
 * line per page.
 */
export const SHOOT_SCRIPT = String.raw`import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
const [mode, dir, base, pagesFile, out] = process.argv.slice(2);
const require = createRequire(join(dir, "package.json"));
let chromium;
for (const name of ["playwright", "playwright-core", "@playwright/test"]) {
	try {
		chromium = require(name).chromium;
		if (chromium) break;
	} catch {}
}
if (!chromium) {
	console.log("none: no Playwright in the project");
	process.exit(0);
}
let executable;
try {
	executable = chromium.executablePath();
} catch {}
if (!executable || !existsSync(executable)) {
	console.log("none: no Chromium installed");
	process.exit(0);
}
if (mode === "probe") {
	console.log("ok");
	process.exit(0);
}
const pages = JSON.parse(readFileSync(pagesFile, "utf8"));
const browser = await chromium.launch();
try {
	const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
	for (const [i, wanted] of pages.entries()) {
		const page = await context.newPage();
		try {
			const response = await page.goto(base + wanted.path, { waitUntil: "load", timeout: 60000 });
			if (response && response.status() >= 400) throw new Error("status " + response.status());
			await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
			await page.waitForTimeout(500);
			const file = join(out, i + ".png");
			await page.screenshot({ path: file });
			console.log(JSON.stringify({ i, file }));
		} catch (error) {
			console.log(JSON.stringify({ i, error: String(error && error.message || error).split("\n")[0] }));
		}
		await page.close();
	}
} finally {
	await browser.close();
}
`;

/**
 * One side in bash: a worktree of COMMIT beside the project in DIR, its node_modules borrowed (or installed when
 * INSTALL is 1), PORT freed of whatever the agent left listening on it, the dev server started in a process group of
 * its own, then the shots once it answers, and everything stopped and removed after.
 */
const SIDE_SCRIPT = String.raw`set -u
wt="$WORK/$SIDE"
mkdir -p "$WORK/$SIDE.out"
git -C "$DIR" worktree add -q --detach "$wt" "$COMMIT" || { echo "server: no worktree at $COMMIT"; exit 0; }
cd "$wt"
if [ "$INSTALL" = 1 ]; then
	if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile --prefer-offline >/dev/null 2>&1
	elif [ -f package-lock.json ]; then npm ci --prefer-offline >/dev/null 2>&1
	elif [ -f package.json ]; then pnpm install --prefer-offline >/dev/null 2>&1
	fi
else
	# Hard-linked copies, not symlinks: a dev server may refuse to serve files outside its own directory.
	(cd "$DIR" && find . -path ./.git -prune -o -name node_modules -type d -prune -print) | while read -r nm; do
		[ -d "$wt/$(dirname "$nm")" ] && [ ! -e "$wt/$nm" ] && { cp -al "$DIR/$nm" "$wt/$nm" 2>/dev/null || cp -a "$DIR/$nm" "$wt/$nm"; }
	done
fi
for f in "$DIR"/.env*; do [ -f "$f" ] && [ ! -e "$wt/$(basename "$f")" ] && cp "$f" "$wt/"; done
command -v fuser >/dev/null && fuser -k -n tcp "$PORT" >/dev/null 2>&1 && sleep 1
BROWSER=none PORT="$PORT" setsid bash -lc "$SERVER" >"$WORK/$SIDE.log" 2>&1 </dev/null &
pid=$!
up=
for _ in $(seq 1 $((WAIT * 2))); do
	if curl -s -o /dev/null --max-time 2 "http://localhost:$PORT/"; then up=1; break; fi
	kill -0 "$pid" 2>/dev/null || break
	sleep 0.5
done
if [ -n "$up" ]; then node "$WORK/shoot.mjs" shoot "$wt" "http://localhost:$PORT" "$WORK/pages.json" "$WORK/$SIDE.out"
else echo "server: never answered on port $PORT: $(tail -c 300 "$WORK/$SIDE.log" | tr '\n' ' ')"
fi
kill -TERM -- "-$pid" 2>/dev/null
for _ in 1 2 3 4 5 6; do kill -0 -- "-$pid" 2>/dev/null || break; sleep 0.5; done
kill -KILL -- "-$pid" 2>/dev/null
cd /
git -C "$DIR" worktree remove --force "$wt" >/dev/null 2>&1 || rm -rf "$wt"
git -C "$DIR" worktree prune
`;

/** Runs `command` in the sandbox, returning its exit code and output (the end of it). */
async function sh(env: ExecutionEnv, command: string, options: { cwd?: string; env?: Record<string, string>; timeout?: number }, context: Context): Promise<{ code: number; out: string }> {
	let out = "";
	const ran = await env.exec(["bash", "-lc", command], { ...options, onOutput: (text) => {
		out = (out + text).slice(-20_000);
	} }, context);
	if (!ran.ok) throw ran.error;
	return { code: ran.value.exitCode ?? 1, out };
}

/** What takeShots needs of a session's sandbox. */
export type ShotSandbox = { env: ExecutionEnv; dir: string; base?: string };

/**
 * Takes the shots for the answer at `at` in the project at `dir` in the sandbox: after at HEAD, then before at `base`,
 * and saves them to `<shotsDir>/<session>/`. Empty, without a word, when the project has no browser for it. A page
 * that fails on one side is left out on that side; a dev server that never answers leaves that side out, logged.
 */
export async function takeShots(sandbox: ShotSandbox, session: number, at: number, server: DevServer, declared: readonly Page[], shotsDir: string, context: Context, log: (line: string) => void = () => {}): Promise<Shot[]> {
	const { env, dir } = sandbox;
	// Beside the project, on its filesystem, so node_modules can be hard-linked (/tmp may be another).
	const work = `${dir.replace(/\/[^/]+\/?$/, "")}/.aludra-shots-${session}-${at.toString(36)}`;
	await sh(env, 'rm -rf "$WORK" && mkdir -p "$WORK"', { env: { WORK: work } }, context);
	try {
		const put = await env.writeFile(`${work}/shoot.mjs`, SHOOT_SCRIPT, context);
		if (!put.ok) throw put.error;
		const probe = await sh(env, `node "$WORK/shoot.mjs" probe "$DIR"`, { env: { WORK: work, DIR: dir }, timeout: 60 }, context);
		if (probe.out.trim() !== "ok") {
			log(`session ${session}: no screenshots, ${probe.out.trim().replace(/^none: /, "") || `the probe exited with ${probe.code}`}`);
			return [];
		}
		const head = (await sh(env, "git rev-parse HEAD", { cwd: dir }, context)).out.trim();
		const changed = sandbox.base === undefined ? [] : (await sh(env, 'git diff --name-only "$BASE" HEAD', { cwd: dir, env: { BASE: sandbox.base } }, context)).out.split("\n").filter((f) => f !== "");
		const pages = pagesToShoot(declared, routesFromFiles(changed));
		const written = await env.writeFile(`${work}/pages.json`, JSON.stringify(pages), context);
		if (!written.ok) throw written.error;
		const depsChanged = sandbox.base !== undefined && (await sh(env, 'git diff --quiet "$BASE" HEAD -- package.json pnpm-lock.yaml package-lock.json yarn.lock', { cwd: dir, env: { BASE: sandbox.base } }, context)).code !== 0;
		const sides: { side: Shot["side"]; commit: string; install: boolean }[] = [{ side: "after", commit: head, install: false }];
		if (sandbox.base !== undefined) sides.push({ side: "before", commit: sandbox.base, install: depsChanged });
		const local = join(shotsDir, String(session));
		await mkdir(local, { recursive: true });
		const shots: Shot[] = [];
		for (const { side, commit, install } of sides) {
			const vars = { WORK: work, SIDE: side, DIR: dir, COMMIT: commit, INSTALL: install ? "1" : "0", PORT: String(server.port), SERVER: server.command, WAIT: String(SERVER_WAIT_S) };
			const ran = await sh(env, SIDE_SCRIPT, { cwd: dir, env: vars, timeout: SIDE_TIMEOUT_S }, context);
			for (const line of ran.out.split("\n")) {
				if (line.startsWith("server: ")) log(`session ${session}: ${side} shots: ${line.slice(8)}`);
				if (!line.startsWith("{")) continue;
				let got: { i?: number; file?: string; error?: string };
				try {
					got = JSON.parse(line);
				} catch {
					continue;
				}
				const page = pages[got.i ?? -1];
				if (page === undefined) continue;
				if (got.file === undefined) {
					log(`session ${session}: ${side} shot of ${page.path}: ${got.error ?? "failed"}`);
					continue;
				}
				const bytes = await env.readBinaryFile(got.file, context);
				if (!bytes.ok) continue;
				const id = `${at.toString(36)}-${side}-${got.i}`;
				await writeFile(join(local, `${id}.png`), bytes.value);
				shots.push({ id, label: page.label ?? page.path, side, path: page.path });
			}
		}
		return shots;
	} finally {
		await sh(env, 'rm -rf "$WORK"', { env: { WORK: work } }, context).catch(() => {});
	}
}

/** A saved shot's PNG, or undefined when there's no such shot or it has been swept. */
export async function readShot(shotsDir: string, session: number, id: string): Promise<Buffer | undefined> {
	if (!/^[a-z0-9]+-(?:before|after)-\d+$/.test(id)) return undefined;
	return readFile(join(shotsDir, String(session), `${id}.png`)).catch(() => undefined);
}
