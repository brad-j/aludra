// Notifications on this device: Web Push through the service worker (app/public/sw.js), signed up with the host
// (src/push.ts). On an iPhone, only the app added to the Home Screen can get them.
import type { PushState } from "../../src/api-types.ts";
import { post } from "./live.ts";

export type PushHere = "unsupported" | "install-first" | "blocked" | "off" | "on";

const registration = () => navigator.serviceWorker.getRegistration();

/** Whether this device can get notifications, and whether it does. */
export async function pushHere(): Promise<PushHere> {
	const standalone = matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
	if (!("serviceWorker" in navigator) || !("PushManager" in window)) return /iPhone|iPad/.test(navigator.userAgent) && !standalone ? "install-first" : "unsupported";
	if (Notification.permission === "denied") return "blocked";
	return (await (await registration())?.pushManager.getSubscription()) == null ? "off" : "on";
}

/** The label a device is listed with: the kind of device and browser. */
function label(): string {
	const ua = navigator.userAgent;
	const device = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "computer";
	const browser = /CriOS|Chrome/.test(ua) ? "Chrome" : /Firefox|FxiOS/.test(ua) ? "Firefox" : /Safari/.test(ua) ? "Safari" : "browser";
	return `${device} · ${browser}`;
}

export async function turnOn(): Promise<void> {
	const state = await fetch("/api/push").then((r) => r.json() as Promise<PushState>);
	if ((await Notification.requestPermission()) !== "granted") throw new Error("Notifications aren't allowed for aludra. Allow them in the device's settings, then try again.");
	const reg = (await registration()) ?? (await navigator.serviceWorker.register("/sw.js"));
	// The newest service worker, which shows notifications; one from before them would drop every push.
	await reg.update().catch(() => {});
	await navigator.serviceWorker.ready;
	const subscription = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: state.publicKey });
	const json = subscription.toJSON();
	await post("/api/push/subscribe", { endpoint: json.endpoint, keys: json.keys, label: label() });
}

export async function turnOff(): Promise<void> {
	const subscription = await (await registration())?.pushManager.getSubscription();
	if (!subscription) return;
	await post("/api/push/unsubscribe", { endpoint: subscription.endpoint });
	await subscription.unsubscribe();
}

/** Asks the host for a test notification, which comes a few seconds later. */
export const sendTest = () => post<{ devices: number; inSeconds: number }>("/api/push/test", {});
