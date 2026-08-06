// The quick-access panel's webview entry. Slice 1 is the shell: this proves the window,
// the hotkey and the native backdrop. The combobox and its actions land next; see
// docs/desktop-port.md for the interaction model they implement.

import { invoke } from "@tauri-apps/api/core";
import { Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "@core/styles/index.css";
import "./styles/spotlight.css";

function Spotlight() {
	const input = useRef<HTMLInputElement>(null);
	const [query, setQuery] = useState("");

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
		<div className="h-full flex flex-col text-foreground">
			<div className="flex items-center gap-3 px-4 h-14 shrink-0 border-b border-white/10">
				<Search className="w-4 h-4 shrink-0 text-muted-foreground" aria-hidden />
				<input
					ref={input}
					type="text"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					placeholder="Search your vault"
					aria-label="Search your vault"
					autoComplete="off"
					spellCheck={false}
					className="flex-1 bg-transparent border-0 outline-none text-base placeholder:text-muted-foreground"
				/>
			</div>
			<div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
				Results land in the next slice.
			</div>
		</div>
	);
}

const el = document.getElementById("root");
if (el) createRoot(el).render(<Spotlight />);
