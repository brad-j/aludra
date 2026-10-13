import { defineConfig, devices } from "@playwright/test";

// The host with the faux model and fresh data, serving the built app (pnpm e2e builds it first). WebKit needs system
// libraries this machine doesn't have, so phones are Chromium at an iPhone's size, with touch.
const { defaultBrowserType: _, ...iphone } = devices["iPhone 15"];
const identity = { "tailscale-user-login": "you@example.com" };

export default defineConfig({
	testDir: "e2e",
	outputDir: "e2e/results/output",
	workers: 1,
	timeout: 30_000,
	use: { baseURL: "http://127.0.0.1:8726", extraHTTPHeaders: identity, serviceWorkers: "block", trace: "retain-on-failure" },
	projects: [
		{ name: "phone", use: { ...iphone } },
		{ name: "desk", use: { viewport: { width: 1280, height: 800 } } },
	],
	webServer: {
		command: "node --no-warnings e2e/setup.ts && node --no-warnings src/main.ts serve",
		env: { ALUDRA_CONFIG: "e2e/aludra.json", ALUDRA_DATA_DIR: "e2e/results/data", ALUDRA_MODEL: "faux" },
		url: "http://127.0.0.1:8726/api/bootstrap",
		reuseExistingServer: false,
		stdout: "ignore",
		stderr: "pipe",
	},
});
