// The app (app/): TanStack Start in SPA mode. `pnpm build` writes it to dist/client, which the host serves beside its
// API (src/api.ts). `pnpm dev` runs Vite on loopback and sends /api to a running host, adding the Tailscale login
// tailscale serve would add, so durable work never restarts with the app.
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { loadConfig } from "./src/config.ts";

const { config } = loadConfig();
const host = `127.0.0.1:${config.api.port}`;
const identity = config.api.user === undefined ? {} : { "tailscale-user-login": config.api.user };

export default defineConfig({
	publicDir: "app/public",
	server: {
		host: "127.0.0.1",
		port: 8725,
		proxy: { "/api": { target: `http://${host}`, ws: true, headers: identity } },
	},
	plugins: [
		tanstackStart({ srcDirectory: "app", spa: { enabled: true } }),
		// React's plugin must come after Start's.
		viteReact(),
	],
});
