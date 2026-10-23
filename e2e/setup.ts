// Before the e2e host starts: a scratch git project, gamma, for the changes view, in e2e/results (which git ignores) as
// its own repository; loose, a project outside any repository, in /tmp; the settings, copied into e2e/results so the
// settings test saves there; and a project for each Playwright project that only a root added in that test finds.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const results = join(import.meta.dirname, "results");
rmSync(results, { recursive: true, force: true });
const gamma = join(results, "projects", "Software", "gamma");
mkdirSync(gamma, { recursive: true });
const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.com", ...args], { cwd: gamma });
git("init", "-q", "-b", "main");
writeFileSync(join(gamma, "README.md"), "# gamma\n");
// One file for each Playwright project to edit, so the two runs don't see each other's changes.
for (const name of ["phone", "desk"]) writeFileSync(join(gamma, `${name}.txt`), "Started.\n");
git("add", "-A");
git("commit", "-qm", "start");

const loose = "/tmp/aludra-e2e/loose";
rmSync("/tmp/aludra-e2e", { recursive: true, force: true });
mkdirSync(loose, { recursive: true });

copyFileSync(join(import.meta.dirname, "aludra.json"), join(results, "aludra.json"));
for (const name of ["phone", "desk"]) mkdirSync(join(results, `extra-${name}`, `zeta-${name}`), { recursive: true });
