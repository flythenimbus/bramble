// The quick-access panel's webview entry. Slice 1 is the shell: this proves the window,
// the hotkey and the native backdrop. The combobox and its actions land next; see
// docs/desktop-port.md for the interaction model they implement.

import { invoke } from "@tauri-apps/api/core";
import { ArrowDown, ArrowUp, CornerDownLeft, Search } from "lucide-react";
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

/**
 * The modifier this platform actually uses, as the symbol its users expect to see.
 *
 * A Mac showing "Ctrl" is wrong twice over: Control is a different key that exists on the same
 * keyboard, so the hint is not merely unidiomatic, it names the wrong thing to press.
 */
const MOD = /mac/i.test(navigator.userAgent) ? "\u2318" : "Ctrl";

/** One key, drawn as a key. */
function Key({ children }: { children: React.ReactNode }) {
	return (
		<kbd className="inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded border border-white/15 bg-white/10 text-[0.7rem] font-medium leading-none text-foreground/80">
			{children}
		</kbd>
	);
}

/** A shortcut and what it does. */
function Hint({ keys, label }: { keys: React.ReactNode; label: string }) {
	return (
		<span className="inline-flex items-center gap-1.5">
			<span className="inline-flex items-center gap-0.5">{keys}</span>
			<span className="text-foreground/45">{label}</span>
		</span>
	);
}

/** Metadata only. A result never carries a secret; acting on one asks for that separately. */
interface Match {
	id: string;
	name: string;
	secondary: string;
}

/** Enough to fill the panel without turning it into a vault browser. */
const MAX_RESULTS = 8;

function Spotlight() {
	const input = useRef<HTMLInputElement>(null);
	const panel = useRef<HTMLDivElement>(null);
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<Match[]>([]);
	const [selected, setSelected] = useState(0);
	/** The page a fill would land on, as the browser last reported it. */
	const [target, setTarget] = useState<string | null>(null);
	/** What the last Enter actually did. Silence here cost an evening: a fill that found no
	 * browser, no field, or a page the entry is not for looked identical to one that worked. */
	const [outcome, setOutcome] = useState<string | null>(null);
	/** The current results, for the key handler. It is bound once, so reading state directly
	 * would close over whatever was on screen when the window opened. */
	const latest = useRef<Match[]>([]);
	latest.current = results;
	/** The highlighted index, for the same reason. */
	const selectedRef = useRef(0);
	selectedRef.current = selected;

	useWindowTracksContent(panel);

	// Search on every keystroke. The index lives in the Rust process and is metadata only, so
	// this is a lookup over a few hundred rows rather than anything the vault has to unlock.
	useEffect(() => {
		let cancelled = false;
		void invoke<Match[]>("spotlight_search", { query, limit: MAX_RESULTS })
			.then((hits) => {
				if (cancelled) return;
				setResults(hits);
				// Back to the top on every new search: the old highlight belonged to a list that
				// no longer exists, and leaving it would act on whatever happened to slide under it.
				setSelected(0);
			})
			.catch(() => {
				if (!cancelled) setResults([]);
			});
		return () => {
			cancelled = true;
		};
	}, [query]);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				void invoke("spotlight_hide");
				return;
			}
			if (e.key === "ArrowDown" || e.key === "ArrowUp") {
				// Held rather than left to the input, which would otherwise move the caret.
				e.preventDefault();
				const count = latest.current.length;
				if (count === 0) return;
				setSelected((i) => {
					const next = e.key === "ArrowDown" ? i + 1 : i - 1;
					// Wraps, because a list this short is faster to cycle than to reverse out of.
					return (next + count) % count;
				});
				return;
			}
			if (e.key === "Enter") {
				e.preventDefault();
				const match = latest.current[selectedRef.current];
				if (!match) return;
				void (async () => {
					// The copy always happens: the browser refuses a page the entry is not for, and
					// there may be no browser at all, so this is what keeps Enter from sometimes
					// doing nothing. The secret never comes back here; the shell reads it from its
					// own index and writes the clipboard itself.
					const copied = await invoke("spotlight_copy_password", { id: match.id })
						.then(() => true)
						.catch(() => false);
					// The reason matters here, not just the failure: a mismatched page is a
					// different thing from no browser at all.
					const filled = await invoke("spotlight_request_fill", { id: match.id })
						.then(() => true as const)
						.catch((e) => {
							const message = typeof e === "string" ? e : String(e);
							return message.startsWith("that entry is not for") ? message : false;
						});
					if (filled === true) {
						// The browser still has the last word: it needs a field to put this in.
						// Saying "asked" rather than "filled" is the honest claim from this side.
						void invoke("spotlight_hide");
						return;
					}
					setOutcome(
						// The refusal is worth repeating verbatim: "that entry is not for
						// github.com" tells the user what happened, where "could not fill" starts
						// an investigation.
						typeof filled === "string"
							? `${filled}. Password copied instead.`
							: copied
								? "No browser to fill. Password copied instead."
								: "Could not copy: is the vault still unlocked?",
					);
				})();
				return;
			}
			// The modifier is whichever this platform uses, matching what the hints show.
			const mod = MOD === "Ctrl" ? e.ctrlKey : e.metaKey;
			if (mod && e.key.toLowerCase() === "o") {
				e.preventDefault();
				const match = latest.current[selectedRef.current];
				// The same key applied to whatever is in focus: an entry if one is highlighted,
				// otherwise the app itself.
				void invoke(match ? "spotlight_open_entry" : "spotlight_open_main", { id: match?.id });
			}
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
			setOutcome(null);
			input.current?.focus();
			input.current?.select();
			// Re-read on every appearance. Tabs are switched while the panel is hidden, so a
			// target read once would name a page the fill is not going to.
			void invoke<string | null>("spotlight_active_tab")
				.then(setTarget)
				.catch(() => setTarget(null));
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
					onChange={(e) => {
						setQuery(e.target.value);
						setOutcome(null);
					}}
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
				<div className="border-t border-white/10 py-2">
					{results.length === 0 ? (
						<p className="px-5 py-3 text-sm text-foreground/40">No matches</p>
					) : (
						<ul className="max-h-80 overflow-y-auto">
							{results.map((match, i) => (
								<li key={match.id}>
									{/* Hovering highlights, so pointer and keyboard drive the same selection
									    rather than each having their own idea of what is current. */}
									<button
										type="button"
										onMouseMove={() => setSelected(i)}
										className={`w-full flex items-baseline gap-3 px-5 py-2 text-left ${
											i === selected ? "bg-white/10" : ""
										}`}
									>
										<span className="text-sm truncate">{match.name}</span>
										<span className="text-xs text-foreground/45 truncate">{match.secondary}</span>
									</button>
								</li>
							))}
						</ul>
					)}
				</div>
			)}
			{/* What you can do from here, on its own rule. Always visible: the panel opens with an
			    empty field and no results, which is exactly when someone needs telling what it can
			    do, and a hint that appears only after you have already worked it out is no hint. */}
			<div className="border-t border-white/10 px-5 h-9 flex items-center gap-4 text-[0.7rem] select-none">
				<Hint
					keys={
						<>
							<Key>
								<ArrowUp className="w-3 h-3" aria-hidden />
							</Key>
							<Key>
								<ArrowDown className="w-3 h-3" aria-hidden />
							</Key>
						</>
					}
					label="Navigate"
				/>
				{outcome && (
					<p className="border-t border-white/10 px-5 py-2 text-xs text-foreground/60">{outcome}</p>
				)}
				{/* Names the page a fill would land on, so nobody commits to one blind. Falls back
				    to the clipboard wording when no browser has reported a page, which is the
				    honest label for what Enter can still do then. */}
				<Hint
					keys={
						<Key>
							<CornerDownLeft className="w-3 h-3" aria-hidden />
						</Key>
					}
					label={target ? `Fill on ${target}` : "Copy password"}
				/>
				<Hint
					keys={
						<>
							<Key>{MOD}</Key>
							<Key>O</Key>
						</>
					}
					label="Open in Bramble"
				/>
			</div>
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
