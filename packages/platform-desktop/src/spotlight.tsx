// The quick-access panel's webview entry. Slice 1 is the shell: this proves the window,
// the hotkey and the native backdrop. The combobox and its actions land next; see
// docs/desktop-port.md for the interaction model they implement.

import { invoke } from "@tauri-apps/api/core";
import { Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles/index.css";
import "./styles/spotlight.css";

/** Keep the window the same height as the panel, so it is a bare search field until there
 * is something to show. The window is transparent, so an oversized one is not empty space,
 * it is a pane of blur sitting over the desktop with nothing in it. */
function useWindowTracksContent(ref: React.RefObject<HTMLElement | null>) {
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		let frame = 0;
		const sync = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => {
				void invoke("spotlight_set_height", { height: el.offsetHeight });
			});
		};
		const observer = new ResizeObserver(sync);
		observer.observe(el);
		sync();
		return () => {
			observer.disconnect();
			cancelAnimationFrame(frame);
		};
	}, [ref]);
}

function Spotlight() {
	const input = useRef<HTMLInputElement>(null);
	const panel = useRef<HTMLDivElement>(null);
	const [query, setQuery] = useState("");

	useWindowTracksContent(panel);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") void invoke("spotlight_hide");
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	// The panel is shown and hidden rather than created and destroyed, so its React tree
	// survives between openings and a mount-time focus would only ever fire once. Refocus
	// and reset on every appearance instead, so it always opens ready to type.
	useEffect(() => {
		const onFocus = () => {
			setQuery("");
			input.current?.focus();
			input.current?.select();
		};
		window.addEventListener("focus", onFocus);
		onFocus();
		return () => window.removeEventListener("focus", onFocus);
	}, []);

	return (
		<div ref={panel} className="text-foreground">
			<div className="flex items-center gap-5 px-5 h-16">
				<Search className="w-5 h-5 shrink-0 text-foreground/40" aria-hidden />
				<input
					ref={input}
					type="text"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					placeholder="Search your vault"
					aria-label="Search your vault"
					autoComplete="off"
					spellCheck={false}
					// The placeholder is dimmer than the text it stands in for, so it reads as a
					// prompt rather than as content already entered. Typed text keeps full
					// foreground, which is the contrast that actually matters on a blurred
					// backdrop.
					className="flex-1 bg-transparent border-0 outline-none text-xl font-medium placeholder:text-foreground/40 placeholder:font-medium"
				/>
			</div>
			{/* Only once there is a query. An empty results area is dead space the user has to
			    look past, and on a transparent window it is worse than dead: it is a pane of
			    blur over whatever they were reading. */}
			{query.length > 0 && (
				<div className="border-t border-white/10 px-4 py-6 text-sm text-muted-foreground">
					Results land in the next slice.
				</div>
			)}
		</div>
	);
}

const el = document.getElementById("root");
if (el) {
	// Keep the root on the window rather than making one per module evaluation. Vite re-runs
	// this file on every edit, and a second createRoot against the same container is an error
	// React reports and then renders through anyway, which is noise that hides real ones.
	const host = window as typeof window & { __spotlightRoot?: ReturnType<typeof createRoot> };
	host.__spotlightRoot ??= createRoot(el);
	host.__spotlightRoot.render(<Spotlight />);
}
