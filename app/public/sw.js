// aludra's service worker, served as /sw.js (after gaidin's web/sw.js). It shows aludra's notifications (src/push.ts),
// opens the session a tapped one is about, and answers with a short page when the host can't be reached, such as from
// a phone off the tailnet. It caches nothing.

const OFFLINE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark"><title>aludra</title>
<style>body{margin:0;min-height:100dvh;display:grid;place-content:center;gap:12px;padding:24px;background:#0e0e10;color:#e8e8ea;
font:17px/1.5 "Fira Sans",Seravek,Ubuntu,sans-serif;text-align:center}p{margin:0;color:#b8b9bc}
button{justify-self:center;min-height:44px;padding:0 16px;border:1px solid #45464a;border-radius:8px;background:transparent;color:inherit;font:inherit}</style></head>
<body><strong>aludra can't be reached</strong><p>Check that this device is on the tailnet and that the host is running.</p><button onclick="location.reload()">Try again</button></body></html>`;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
	let message = {};
	try {
		message = event.data?.json() ?? {};
	} catch {}
	// Every push shows a notification: browsers stop delivering to apps that don't.
	event.waitUntil(
		self.registration.showNotification(message.title ?? "aludra", {
			body: message.body ?? "",
			tag: message.tag,
			icon: "/icon-192.png",
			badge: "/icon-192.png",
			data: { url: message.url ?? "/" },
		}),
	);
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const url = new URL(event.notification.data?.url ?? "/", self.location.origin).href;
	event.waitUntil(
		(async () => {
			const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
			const client = open.find((c) => new URL(c.url).origin === self.location.origin);
			if (client === undefined) return self.clients.openWindow(url);
			await client.focus();
			return client.navigate(url).catch(() => client.postMessage({ type: "open", url }));
		})(),
	);
});

self.addEventListener("fetch", (event) => {
	if (event.request.mode !== "navigate") return;
	event.respondWith(fetch(event.request).catch(() => new Response(OFFLINE, { headers: { "Content-Type": "text/html; charset=utf-8" } })));
});
