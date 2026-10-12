// The frame every screen sits in: the sessions drawer (a column on the desk), the main pane, one bottom sheet at a
// time, and the keyboard fix that keeps the composer above the iOS keyboard.
import { createContext, type ReactNode, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Drawer } from "./Drawer.tsx";

type Ui = {
	drawer: boolean;
	setDrawer: (open: boolean) => void;
	/** Opens a sheet titled `title`; `body` gets a function that closes it. */
	sheet: (title: string, body: (close: () => void) => ReactNode) => void;
};

const UiContext = createContext<Ui | undefined>(undefined);

export function useUi(): Ui {
	const ui = useContext(UiContext);
	if (ui === undefined) throw new Error("useUi outside the Shell");
	return ui;
}

const WIDE = "(min-width: 60rem)";

export function Shell({ children, startWithDrawer }: { children: ReactNode; startWithDrawer: boolean }) {
	const [drawer, setDrawerState] = useState(false);
	// The drawer slides only once the app has drawn: not when the shell's HTML gives way to the app.
	const [ready, setReady] = useState(false);
	useLayoutEffect(() => {
		// A phone landing on the app opens on the drawer: what every session is doing, at a glance.
		if (startWithDrawer && !matchMedia(WIDE).matches) setDrawerState(true);
		requestAnimationFrame(() => requestAnimationFrame(() => setReady(true)));
		// Only on arrival.
	}, []);
	const [sheet, setSheet] = useState<{ title: string; body: (close: () => void) => ReactNode } | undefined>(undefined);
	const [open, setOpen] = useState(false);
	const lastFocus = useRef<Element | null>(null);

	const setDrawer = useCallback((value: boolean) => setDrawerState(value), []);
	const openSheet = useCallback((title: string, body: (close: () => void) => ReactNode) => {
		lastFocus.current = document.activeElement;
		setSheet({ title, body });
		requestAnimationFrame(() => setOpen(true));
	}, []);
	const closeSheet = useCallback(() => {
		setOpen(false);
		setTimeout(() => setSheet(undefined), 300);
		if (lastFocus.current instanceof HTMLElement) lastFocus.current.focus({ preventScroll: true });
	}, []);

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			if (sheet !== undefined) closeSheet();
			else setDrawerState(false);
		};
		addEventListener("keydown", onKey);
		return () => removeEventListener("keydown", onKey);
	}, [sheet, closeSheet]);

	useKeyboardFit();
	const ui = useMemo(() => ({ drawer, setDrawer, sheet: openSheet }), [drawer, setDrawer, openSheet]);

	return (
		<UiContext.Provider value={ui}>
			<div className="app" data-drawer={drawer ? "open" : "closed"} data-ready={ready || undefined}>
				<Drawer />
				<div className="scrim" onClick={() => setDrawerState(false)} />
				<main className="main">{children}</main>
			</div>
			{sheet !== undefined && (
				<>
					<div className="sheet-backdrop" data-open={open} onClick={closeSheet} />
					<div className="sheet" data-open={open} role="dialog" aria-modal="true" aria-label={sheet.title}>
						<div className="grabber" />
						<h2>{sheet.title}</h2>
						<SheetFocus />
						{sheet.body(closeSheet)}
					</div>
				</>
			)}
		</UiContext.Provider>
	);
}

/** Moves focus into a sheet as it opens, to its search box or first button. */
function SheetFocus() {
	const ref = useRef<HTMLSpanElement>(null);
	useEffect(() => {
		const sheet = ref.current?.closest(".sheet");
		const target = sheet?.querySelector<HTMLElement>("input, button");
		target?.focus({ preventScroll: true });
	}, []);
	return <span ref={ref} hidden />;
}

/**
 * iOS doesn't shrink the layout viewport for the keyboard, so a bottom composer would sit under it. The app's height
 * follows the visual viewport instead (--vvh), and sheets rise by the keyboard's height (--keyboard).
 */
function useKeyboardFit() {
	useEffect(() => {
		const viewport = window.visualViewport;
		if (!viewport) return;
		const root = document.documentElement;
		const fit = () => {
			root.style.setProperty("--vvh", `${viewport.height}px`);
			root.style.setProperty("--keyboard", `${Math.max(0, innerHeight - viewport.height - viewport.offsetTop)}px`);
			// iOS scrolls the page to show a focused input; the app scrolls inside its panes instead.
			if (scrollY !== 0) scrollTo(0, 0);
		};
		viewport.addEventListener("resize", fit);
		viewport.addEventListener("scroll", fit);
		fit();
		return () => {
			viewport.removeEventListener("resize", fit);
			viewport.removeEventListener("scroll", fit);
		};
	}, []);
}

/** Re-renders every `ms`, for ages that tick. */
export function useTick(ms = 30_000): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), ms);
		return () => clearInterval(timer);
	}, [ms]);
	return now;
}
