// The app against a host running the faux model (playwright.config.ts): starting sessions, watching a run, steering,
// queueing, stopping, model and thinking, approvals, and the layout at phone and desk sizes.
import { expect, type Page, test } from "@playwright/test";

const phone = (page: Page) => (page.viewportSize()?.width ?? 0) < 960;

/** Starts a session in `project` from the new-session screen and returns its id. */
async function start(page: Page, project: string, text: string): Promise<number> {
	await page.goto("/");
	if (phone(page)) await page.locator(".scrim").click({ position: { x: (page.viewportSize()!.width - 20), y: 300 } });
	await page.locator(".who .path").click();
	await page.getByLabel("Find a project").fill(project);
	await page.locator(".sheet .pick").filter({ hasText: project }).first().click();
	await expect(page.locator(".who .path")).toContainText(project);
	await page.getByLabel("What should it do?").fill(text);
	await page.getByRole("button", { name: "Start session" }).click();
	await expect(page).toHaveURL(/\/s\/\d+$/);
	return Number(/\/s\/(\d+)$/.exec(page.url())![1]);
}

test("a phone opens on the sessions drawer, and closing it shows the new-session screen", async ({ page }) => {
	test.skip(!phone(page), "phones only");
	await page.goto("/");
	await expect(page.locator(".app")).toHaveAttribute("data-drawer", "open");
	await expect(page.locator(".machine")).toContainText("local");
	await page.locator(".scrim").click({ position: { x: page.viewportSize()!.width - 20, y: 300 } });
	await expect(page.locator(".app")).toHaveAttribute("data-drawer", "closed");
	await expect(page.getByRole("heading", { name: "New session" })).toBeVisible();
});

test("a session runs its command live, then folds it into one line that opens", async ({ page }) => {
	await start(page, "beta", "Where are you? Run pwd.");
	await expect(page.locator(".block.live")).toContainText("sleep 4 && pwd");
	await expect(page.locator(".prose")).toContainText("Tool came back", { timeout: 10_000 });
	const fold = page.locator(".fold-row");
	await expect(fold).toContainText("ran 1 command");
	await fold.click();
	await page.locator(".call-row .arg").click();
	await expect(page.locator(".calls .block pre")).toContainText("e2e/projects/Software/beta");
	// The list shows it done, under its project.
	if (phone(page)) await page.getByRole("button", { name: "Sessions" }).first().click();
	const row = page.locator(".dir").filter({ hasText: "beta" }).locator(".session-row").first();
	await expect(row).toHaveAttribute("data-state", "done");
	await expect(row).toContainText("Where are you? Run pwd.");
});

test("while it runs: a steer joins it, a queued message waits and can be taken back, and stop ends it", async ({ page }) => {
	await start(page, "alpha", "Run a slow command");
	await expect(page.locator(".block.live")).toBeVisible();
	await page.getByLabel("Steer or queue a message").fill("Also check the README");
	await page.getByRole("button", { name: "Send", exact: true }).click();
	await expect(page.locator(".user")).toContainText(["Run a slow command", "Also check the README"], { timeout: 10_000 });

	await page.getByRole("button", { name: /tap to queue instead/ }).click();
	await page.getByLabel("Steer or queue a message").fill("Then update the docs");
	await page.getByRole("button", { name: "Send", exact: true }).click();
	const queued = page.locator(".queued li");
	await expect(queued).toContainText("Then update the docs");
	await queued.getByRole("button", { name: "Take back" }).click();
	await expect(queued).toHaveCount(0);

	await page.getByRole("button", { name: "Stop the run" }).click();
	await expect(page.locator(".note")).toContainText("Stopped");
	await expect(page.getByLabel("Follow up")).toBeVisible();
});

test("an answer renders as Markdown, and the model and thinking change from the composer", async ({ page }) => {
	await start(page, "alpha", "Show me some markdown");
	const answer = page.locator(".prose").last();
	await expect(answer.locator("ol li")).toHaveCount(3);
	await expect(answer.locator("table")).toContainText("26 passed");
	await expect(answer.locator("pre")).toContainText("createApi");
	await expect(answer.locator("blockquote")).toContainText("Nothing is pushed yet.");
	// Nothing in an answer runs as markup.
	await expect(answer.locator("script")).toHaveCount(0);

	await page.locator(".dock .meta").click();
	await page.locator(".sheet .seg").getByRole("button", { name: "low", exact: true }).click();
	await page.keyboard.press("Escape");
	await expect(page.locator(".dock .meta")).toContainText("faux-1 · low");
});

test("a session is renamed from its menu, and the header and the drawer show the new title", async ({ page }, info) => {
	// Phone and desk share one host, so each names its session its own way.
	const name = `A better name, ${info.project.name}`;
	await start(page, "alpha", "Say something short");
	await page.getByRole("button", { name: "Session menu" }).first().click();
	await page.locator(".sheet").getByRole("button", { name: "Rename" }).click();
	const field = page.locator(".sheet").getByLabel("Title");
	await expect(field).toHaveValue("Say something short");
	await field.fill(name);
	await page.locator(".sheet").getByRole("button", { name: "Rename" }).click();
	await expect(page.locator("header h1")).toHaveText(name);
	if (phone(page)) await page.getByRole("button", { name: "Sessions" }).first().click();
	await expect(page.locator(".session-row").filter({ hasText: name })).toHaveCount(1);
});

test("a session is archived from its menu into a folded group at the end of the drawer, and brought back", async ({ page }, info) => {
	const name = `Archive me, ${info.project.name}`;
	await start(page, "alpha", "Say something short");
	await page.getByRole("button", { name: "Session menu" }).first().click();
	await page.locator(".sheet").getByRole("button", { name: "Rename" }).click();
	await page.locator(".sheet").getByLabel("Title").fill(name);
	await page.locator(".sheet").getByRole("button", { name: "Rename" }).click();
	await expect(page.locator("header h1")).toHaveText(name);

	await page.getByRole("button", { name: "Session menu" }).first().click();
	await page.locator(".sheet").getByRole("button", { name: /^Archive/ }).click();
	if (phone(page)) await page.getByRole("button", { name: "Sessions" }).first().click();
	const archived = page.locator(".dir.archived");
	await expect(archived.locator(".session-row").filter({ hasText: name })).toHaveCount(0);
	await expect(page.locator(".dir:not(.archived) .session-row").filter({ hasText: name })).toHaveCount(0);
	await archived.locator(".dir-head").click();
	await archived.locator(".session-row").filter({ hasText: name }).click();

	await page.getByRole("button", { name: "Session menu" }).first().click();
	await page.locator(".sheet").getByRole("button", { name: "Bring back from the archive" }).click();
	if (phone(page)) await page.getByRole("button", { name: "Sessions" }).first().click();
	await expect(page.locator(".dir:not(.archived) .session-row").filter({ hasText: name })).toHaveCount(1);
});

test("an image is attached, shown before sending, and in the transcript after, opening full size", async ({ page }) => {
	await start(page, "alpha", "Say something short");
	// 2×2 red PNG.
	const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8AARAwQCgAf7gP9i18U1AAAAABJRU5ErkJggg==", "base64");
	await page.locator(".dock input[type=file]").setInputFiles({ name: "red.png", mimeType: "image/png", buffer: png });
	await expect(page.locator(".attachments img")).toHaveCount(1);
	await page.getByLabel("Follow up").fill("What color is this?");
	await page.getByRole("button", { name: "Send" }).click();
	await expect(page.locator(".attachments")).toHaveCount(0);
	const thumb = page.locator(".user .images img").last();
	await expect(thumb).toBeVisible();
	await expect.poll(() => thumb.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(2);
	await page.locator(".user .images .thumb").last().click();
	await expect(page.locator(".sheet img.full")).toBeVisible();
});

test("a git push waits for approval above the composer, and Deny blocks it", async ({ page }) => {
	await start(page, "alpha", "Commit and push");
	const approval = page.locator(".approval");
	await expect(approval).toContainText("git push --dry-run");
	if (phone(page)) {
		await page.getByRole("button", { name: "Sessions" }).first().click();
		await expect(page.locator(".session-row[data-state='waiting']")).toContainText("Commit and push");
		await page.locator(".scrim").click({ position: { x: page.viewportSize()!.width - 20, y: 300 } });
	}
	await approval.getByRole("button", { name: "Deny" }).click();
	await expect(approval).toHaveCount(0);
	await expect(page.locator(".prose").last()).toContainText("the user said no", { timeout: 10_000 });
});

test("nothing scrolls sideways and no button wraps, from 320 px to the desk", async ({ page }) => {
	test.skip(phone(page), "the desk project runs the widths");
	await page.setViewportSize({ width: 1280, height: 800 });
	const id = await start(page, "alpha", "Show me some markdown");
	for (const width of [320, 375, 414, 768, 1280]) {
		await page.setViewportSize({ width, height: 760 });
		for (const path of ["/", `/s/${id}`]) {
			await page.goto(path);
			if (path !== "/") await page.locator(".prose pre").waitFor();
			await page.waitForTimeout(300);
			const problems = await page.evaluate(() => {
				const found: string[] = [];
				if (document.documentElement.scrollWidth > document.documentElement.clientWidth) found.push("horizontal scroll");
				// The transcript scrolls on its own, so a wide code line would widen it without widening the page.
				const transcript = document.querySelector(".scroll");
				if (transcript && transcript.scrollWidth > transcript.clientWidth) found.push("transcript scrolls sideways");
				for (const el of document.querySelectorAll<HTMLElement>("button, .icon-btn, .mode")) {
					if (el.offsetParent === null || el.closest(".session-row, .fold-row, .file-head, .pick, .path, .arg")) continue;
					if (el.getBoundingClientRect().height > 52) found.push(`tall button: ${el.textContent?.trim().slice(0, 30)}`);
				}
				return found;
			});
			expect(problems, `${path} at ${width}px`).toEqual([]);
		}
	}
});

test("an idea is saved from the new-session screen, filed under its project, and started with one tap", async ({ page }) => {
	await page.goto("/");
	if (phone(page)) await page.locator(".scrim").click({ position: { x: page.viewportSize()!.width - 20, y: 300 } });
	await page.locator(".who .path").click();
	await page.getByLabel("Find a project").fill("trips");
	await page.locator(".sheet .pick").filter({ hasText: "trips" }).first().click();
	const text = `Where are you? Run pwd. (${test.info().project.name})`;
	await page.getByLabel("What should it do?").fill(text);
	await page.getByRole("button", { name: "Save as idea" }).click();
	await expect(page.getByLabel("What should it do?")).toHaveValue("");
	// On the new-session screen for its project, and in the drawer under the project.
	// The phone lists it above the composer, the desk under it; one of the two is hidden.
	await expect(page.locator(".column .idea-row:visible").filter({ hasText: text })).toHaveCount(1);
	if (phone(page)) await page.getByRole("button", { name: "Sessions" }).first().click();
	const row = page.locator(".drawer .dir").filter({ hasText: "trips" }).locator(".idea-row").filter({ hasText: text });
	await expect(row).toBeVisible();
	await expect(page.locator(".drawer .notifications")).toBeVisible();
	await row.getByRole("button", { name: "Start" }).click();
	await expect(page).toHaveURL(/\/s\/\d+$/);
	await expect(page.locator(".user").first()).toHaveText(text);
	await expect(page.locator(".drawer .idea-row").filter({ hasText: text })).toHaveCount(0);
});

test("a session's changes since it started: totals, files by size, each opening to its diff", async ({ page }) => {
	const name = test.info().project.name;
	const id = await start(page, "gamma", `Please write a file for ${name}`);
	await expect(page.locator(".prose").last()).toContainText("Tool came back", { timeout: 10_000 });
	const icon = page.getByRole("link", { name: /^Changes: 2 files/ });
	await expect(icon).toBeVisible({ timeout: 10_000 });
	await icon.click();
	await expect(page).toHaveURL(new RegExp(`/s/${id}/changes$`));
	await expect(page.locator(".totals")).toContainText("+4");
	await expect(page.locator(".totals")).toContainText("−1");
	const rows = page.locator(".file-head");
	await expect(rows).toHaveCount(2);
	await expect(rows.nth(0)).toContainText(`notes-${name}.md`);
	await expect(rows.nth(0)).toContainText("new");
	await rows.nth(1).click();
	await expect(page.locator(".patch .rem")).toHaveText("-Started.");
	await expect(page.locator(".patch .ins")).toHaveText("+Changed by the session.");
	await page.getByRole("link", { name: "Back to the session" }).click();
	await expect(page).toHaveURL(new RegExp(`/s/${id}$`));
});

test("a project outside git says it has no changes to show", async ({ page }) => {
	await start(page, "loose", "Where are you? Run pwd.");
	await page.locator(".who .path").click();
	await expect(page.locator(".empty")).toContainText("not a git repository");
});

test("a no-project session runs in its own scratch directory and is listed under no project", async ({ page }) => {
	await page.goto("/");
	if (phone(page)) await page.locator(".scrim").click({ position: { x: page.viewportSize()!.width - 20, y: 300 } });
	await page.locator(".who .path").click();
	await page.locator(".sheet .pick").filter({ hasText: "No project" }).click();
	await expect(page.locator(".who .path")).toContainText("no project");
	await page.getByLabel("What should it do?").fill("No project here. Run pwd.");
	await page.getByRole("button", { name: "Start session" }).click();
	await expect(page).toHaveURL(/\/s\/\d+$/);
	const id = /\/s\/(\d+)$/.exec(page.url())![1];
	await expect(page.locator(".prose")).toContainText("Tool came back", { timeout: 10_000 });
	await page.locator(".fold-row").click();
	await page.locator(".call-row .arg").click();
	await expect(page.locator(".calls .block pre")).toContainText(`scratch/${id}`);
	if (phone(page)) await page.getByRole("button", { name: "Sessions" }).first().click();
	const group = page.locator(".dir").filter({ hasText: "no project" });
	await expect(group.locator(".where")).toHaveText("scratch");
	await expect(group.locator(".session-row").first()).toContainText("No project here. Run pwd.");
});

test("settings: a root added in the sheet finds a new project at once, and a file-only setting can't be changed", async ({ page }) => {
	const name = test.info().project.name;
	await page.goto("/");
	await page.getByRole("button", { name: "Settings" }).click();
	const sheet = page.getByRole("dialog", { name: "Settings" });
	await expect(sheet.locator('[data-key="api.users"] .setting-fixed')).toHaveText("you@example.com");
	await expect(sheet.locator('[data-key="api.users"]')).toContainText("settings file only");
	await expect(sheet.locator('[data-key="api.users"] input, [data-key="api.users"] textarea')).toHaveCount(0);
	const roots = sheet.getByLabel("test roots, one per line");
	await roots.fill(`${await roots.inputValue()}\ne2e/results/extra-${name}/*`);
	await sheet.getByRole("button", { name: "Save" }).click();
	await expect(sheet.getByRole("status")).toHaveText("Saved.");
	await expect(sheet.getByRole("button", { name: "Save" })).toBeDisabled();
	await page.screenshot({ path: `e2e/results/settings-${name}.png` });
	await sheet.getByRole("button", { name: "Close" }).click();
	if (phone(page)) await page.locator(".scrim").click({ position: { x: page.viewportSize()!.width - 20, y: 300 } });
	await page.locator(".who .path").click();
	await page.getByLabel("Find a project").fill(`zeta-${name}`);
	await expect(page.locator(".sheet .pick").filter({ hasText: `zeta-${name}` })).toBeVisible();
});
