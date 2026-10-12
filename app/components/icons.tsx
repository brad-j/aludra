// The app's icons, drawn on a 24px grid with one stroke, and the state marks, which pair a shape with a colour so
// colour is never the only cue.
import type { ReactNode } from "react";
import type { SessionState } from "../../src/api-types.ts";
import { STATE_LABEL } from "../lib/format.ts";

function Svg({ children }: { children: ReactNode }) {
	return (
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			{children}
		</svg>
	);
}

export const Icon = {
	menu: () => <Svg><path d="M4 7h16M4 12h16M4 17h10" /></Svg>,
	back: () => <Svg><path d="M15 5l-7 7 7 7" /></Svg>,
	more: () => (
		<Svg>
			<circle cx="5" cy="12" r="1.3" fill="currentColor" />
			<circle cx="12" cy="12" r="1.3" fill="currentColor" />
			<circle cx="19" cy="12" r="1.3" fill="currentColor" />
		</Svg>
	),
	plus: () => <Svg><path d="M12 5v14M5 12h14" /></Svg>,
	files: () => <Svg><path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" /></Svg>,
	send: () => <Svg><path d="M12 19V5M6 11l6-6 6 6" /></Svg>,
	stop: () => <Svg><rect x="6" y="6" width="12" height="12" rx="2" /></Svg>,
	down: () => <Svg><path d="M12 5v14M6 13l6 6 6-6" /></Svg>,
	copy: () => (
		<Svg>
			<rect x="8" y="8" width="12" height="12" rx="2" />
			<path d="M16 4.5H6a1.5 1.5 0 0 0-1.5 1.5v10" />
		</Svg>
	),
	check: () => <Svg><path d="M5 12.5l4.5 4.5L19 7.5" /></Svg>,
	close: () => <Svg><path d="M6 6l12 12M18 6L6 18" /></Svg>,
	chevron: () => (
		<svg className="chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
			<path d="M4 6l4 4 4-4" />
		</svg>
	),
};

const MARKS: Record<SessionState | "idea", ReactNode> = {
	running: (
		<svg viewBox="0 0 16 16" aria-hidden="true">
			<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity="0.3" strokeWidth="1.8" />
			<path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
		</svg>
	),
	waiting: (
		<svg viewBox="0 0 16 16" aria-hidden="true">
			<path d="M8 1.5 14.5 8 8 14.5 1.5 8Z" fill="currentColor" />
			<path d="M8 5v3.75M8 11v.01" stroke="var(--color-wait-ink)" strokeWidth="1.6" strokeLinecap="round" />
		</svg>
	),
	failed: (
		<svg viewBox="0 0 16 16" aria-hidden="true">
			<circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
			<path d="M5.75 5.75l4.5 4.5M10.25 5.75l-4.5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
		</svg>
	),
	done: (
		<svg viewBox="0 0 16 16" aria-hidden="true">
			<path d="M3.5 8.5l3 3 6-6.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
		</svg>
	),
	stopped: (
		<svg viewBox="0 0 16 16" aria-hidden="true">
			<rect x="4" y="4" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
		</svg>
	),
	idle: (
		<svg viewBox="0 0 16 16" aria-hidden="true">
			<circle cx="8" cy="8" r="2" fill="currentColor" />
		</svg>
	),
	idea: (
		<svg viewBox="0 0 16 16" aria-hidden="true">
			<circle cx="8" cy="8" r="5.75" fill="none" stroke="currentColor" strokeWidth="1.4" strokeDasharray="2 2.2" />
		</svg>
	),
};

export function Mark({ state }: { state: SessionState | "idea" }) {
	return (
		<span className="mark" data-state={state} role="img" aria-label={STATE_LABEL[state]}>
			{MARKS[state]}
		</span>
	);
}
