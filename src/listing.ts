// `aludra sessions` for a terminal, after the app's sessions drawer: sessions by project, the project that most needs
// you first, each session with the app's state mark, its latest activity and how long ago. Project colors and state
// colors where the terminal shows color; marks of different shapes, so color is never the only cue.
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { SessionState, SessionSummary } from "./api-types.ts";
import { hueOf } from "./project-colors.ts";

/** The project name of no-project sessions (src/host.ts NO_PROJECT); they're gray, under one heading. */
export const NO_PROJECT = "no project";

/** Which needs you most, as the app's drawer orders them (app/lib/format.ts). */
export const URGENCY: Record<SessionState, number> = { waiting: 0, running: 1, failed: 2, stopped: 3, done: 4, idle: 5 };

/** The app's marks (app/components/icons.tsx) as characters. */
export const MARKS: Record<SessionState, string> = { running: "◐", waiting: "◆", failed: "⊘", done: "✓", stopped: "□", idle: "·" };

/** How much color the terminal shows: none, the 16 named colors, the 256-color palette, or 24-bit. */
export type ColorDepth = 1 | 4 | 8 | 24;

export type ListingStyle = { depth: ColorDepth; width: number };

/** What stdout takes: its color depth (which heeds NO_COLOR and FORCE_COLOR) and width, or plain text when piped. */
export function terminalStyle(stream: NodeJS.WriteStream = process.stdout): ListingStyle {
	if (!stream.isTTY) return { depth: process.env.FORCE_COLOR ? 24 : 1, width: 100 };
	const depth = stream.getColorDepth();
	return { depth: depth >= 24 ? 24 : depth >= 8 ? 8 : depth >= 4 ? 4 : 1, width: stream.columns || 100 };
}

type Oklch = readonly [lightness: number, chroma: number, hue: number];

/** The app's colors (app/styles/app.css), with the named color a 16-color terminal shows instead. */
export const INK: Record<"accent" | "wait" | "bad" | "dim", { oklch: Oklch; named: number }> = {
	accent: { oklch: [0.8, 0.13, 300], named: 35 },
	wait: { oklch: [0.84, 0.13, 82], named: 33 },
	bad: { oklch: [0.72, 0.15, 22], named: 31 },
	dim: { oklch: [0.64, 0.006, 260], named: 90 },
};

/** OKLCH to sRGB, 0 to 255, clipped to the gamut. */
export function oklchToRgb([lightness, chroma, hue]: Oklch): [number, number, number] {
	const a = chroma * Math.cos((hue * Math.PI) / 180);
	const b = chroma * Math.sin((hue * Math.PI) / 180);
	const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
	const linear = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
	const gamma = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);
	const [r, g, bl] = linear.map((x) => Math.round(Math.min(1, Math.max(0, gamma(x))) * 255));
	return [r!, g!, bl!];
}

/** Paints text for a terminal of `depth`; with no color, text goes out as it is. */
export function pen(depth: ColorDepth) {
	const sgr = (codes: string, text: string) => (depth === 1 ? text : `\x1b[${codes}m${text}\x1b[0m`);
	const fg = (oklch: Oklch, named?: number) => {
		if (depth === 24) return `38;2;${oklchToRgb(oklch).join(";")}`;
		if (depth === 8) {
			const [r, g, b] = oklchToRgb(oklch).map((x) => Math.round((x / 255) * 5));
			return `38;5;${16 + 36 * r! + 6 * g! + b!}`;
		}
		return named === undefined ? "" : String(named);
	};
	const bg = (oklch: Oklch) => (depth === 24 ? `48;2;${oklchToRgb(oklch).join(";")}` : depth === 8 ? fg(oklch).replace(/^38/, "48") : "7");
	return {
		ink: (name: keyof typeof INK, text: string) => sgr(fg(INK[name].oklch, INK[name].named), text),
		/** Any OKLCH color, for what INK doesn't name. */
		color: (oklch: Oklch, text: string) => sgr(fg(oklch), text),
		bold: (text: string) => sgr("1", text),
		/** A selected row: the project's hue as a dark wash, or reversed where the terminal has only named colors. */
		wash: (name: string, colors: Readonly<Record<string, number>>, text: string) => {
			const code = bg(name === NO_PROJECT ? [0.27, 0, 0] : [0.27, 0.04, hueOf(name, colors)]);
			// Colored parts inside end with a reset; the wash goes back on after each.
			return sgr(code, depth === 1 ? text : text.replaceAll("\x1b[0m", `\x1b[0m\x1b[${code}m`));
		},
		/** A project's name, in its color, a step up in weight like the drawer's. */
		project: (name: string, colors: Readonly<Record<string, number>>, text: string) =>
			sgr(name === NO_PROJECT ? `1;${fg(INK.dim.oklch, INK.dim.named)}` : `1;${fg([0.8, 0.12, hueOf(name, colors)])}`.replace(/;$/, ""), text),
	};
}

/** "now", "6m", "3h", "2d", as the app writes ages. */
export function age(at: number, now: number): string {
	const minutes = Math.max(0, Math.round((now - at) / 60_000));
	if (minutes < 1) return "now";
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.round(minutes / 60);
	return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

export const shortPath = (dir: string) => dir.replace(/^\/home\/[^/]+|^\/Users\/[^/]+/, "~");

/**
 * Sessions by project, as the app's drawer orders them: the project that most needs you first, then the newest, and
 * within each, the same. No-project sessions each have their own scratch directory; they go together in one group.
 */
export function groupSessions(sessions: readonly SessionSummary[]): SessionSummary[][] {
	const groups = new Map<string, SessionSummary[]>();
	for (const s of sessions) {
		const key = s.project === NO_PROJECT ? NO_PROJECT : s.dir;
		groups.set(key, [...(groups.get(key) ?? []), s]);
	}
	const rank = (list: SessionSummary[]) => Math.min(...list.map((s) => URGENCY[s.state]));
	const latest = (list: SessionSummary[]) => Math.max(...list.map((s) => s.updatedAt));
	return [...groups.values()]
		.map((list) => list.sort((a, b) => URGENCY[a.state] - URGENCY[b.state] || b.updatedAt - a.updatedAt))
		.sort((a, b) => rank(a) - rank(b) || latest(b) - latest(a));
}

/** A session's mark, in its state's ink. */
export function markOf(paint: ReturnType<typeof pen>, state: SessionState): string {
	if (state === "running") return paint.ink("accent", MARKS.running);
	if (state === "waiting") return paint.ink("wait", MARKS.waiting);
	if (state === "failed") return paint.ink("bad", MARKS.failed);
	return paint.ink("dim", MARKS[state]);
}

/** The sessions as lines for a terminal of `style`'s width and colors. `colors` are the projects' picked hues. */
export function renderSessions(sessions: readonly SessionSummary[], colors: Readonly<Record<string, number>>, style: ListingStyle, now = Date.now()): string[] {
	if (sessions.length === 0) return ['no sessions yet; start one with aludra ask --project NAME "..."'];
	const paint = pen(style.depth);
	const width = Math.max(40, style.width);
	// pi-tui's truncation ends what it cuts with a reset, which plain text mustn't carry.
	const cut = (text: string, max: number) => (style.depth === 1 ? stripTerminalSequences(truncateToWidth(text, max, "…")) : truncateToWidth(text, max, "…"));
	const ordered = groupSessions(sessions);
	const workspaces = new Set(sessions.map((s) => s.workspace));
	const idWidth = Math.max(...sessions.map((s) => String(s.id).length));
	// The mark, a space, the ID, two spaces: where titles and activity lines start.
	const indent = 2 + 1 + 1 + idWidth + 2;

	const lines: string[] = [];
	for (const list of ordered) {
		const first = list[0]!;
		const where = first.project === NO_PROJECT ? "scratch" : shortPath(first.dir);
		const machine = workspaces.size > 1 ? ` · ${first.workspace}` : "";
		if (lines.length > 0) lines.push("");
		lines.push(cut(`${paint.project(first.project, colors, first.project)}  ${paint.ink("dim", where + machine)}`, width));
		for (const s of list) {
			const mark = markOf(paint, s.state);
			const when = age(s.updatedAt, now);
			const room = width - indent - when.length - 2;
			const title = cut(s.title, room);
			const gap = " ".repeat(Math.max(2, width - indent - visibleWidth(title) - when.length));
			lines.push(`  ${mark} ${paint.ink("dim", String(s.id).padStart(idWidth))}  ${title}${gap}${paint.ink("dim", when)}`);
			if (s.line === "" || s.line === s.title) continue;
			const tone = s.state === "waiting" ? "wait" : s.state === "failed" ? "bad" : "dim";
			lines.push(`${" ".repeat(indent)}${paint.ink(tone, cut(s.line, width - indent))}`);
		}
	}
	return lines;
}
