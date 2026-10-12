import { createRootRoute, HeadContent, Outlet, Scripts, useRouterState } from "@tanstack/react-router";
import { type ReactNode, useEffect } from "react";
import { Shell } from "../components/Shell.tsx";
import css from "../styles/app.css?url";

export const Route = createRootRoute({
	head: () => ({
		meta: [
			{ charSet: "utf-8" },
			{ name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
			{ name: "theme-color", content: "#0e0e10" },
			{ name: "color-scheme", content: "dark" },
			{ name: "apple-mobile-web-app-capable", content: "yes" },
			{ name: "mobile-web-app-capable", content: "yes" },
			{ name: "apple-mobile-web-app-status-bar-style", content: "black-translucent" },
			{ name: "apple-mobile-web-app-title", content: "aludra" },
			{ title: "aludra" },
		],
		links: [
			{ rel: "stylesheet", href: css },
			{ rel: "manifest", href: "/manifest.webmanifest" },
			{ rel: "icon", href: "/icon.svg", type: "image/svg+xml" },
			{ rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
		],
	}),
	component: Root,
});

function Root() {
	const path = useRouterState({ select: (s) => s.location.pathname });
	useEffect(() => {
		// Production only: a service worker in development serves stale code.
		if (import.meta.env.PROD && "serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js");
	}, []);
	return (
		<Document>
			<Shell startWithDrawer={path === "/"}>
				<Outlet />
			</Shell>
		</Document>
	);
}

function Document({ children }: { children: ReactNode }) {
	return (
		<html lang="en">
			<head>
				<HeadContent />
			</head>
			<body>
				{children}
				<Scripts />
			</body>
		</html>
	);
}
