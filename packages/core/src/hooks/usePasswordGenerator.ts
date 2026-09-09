import { useCallback, useEffect, useRef, useState } from "react";
import { type GeneratorSettings, generate } from "../util/password-gen";
import { usePrefs } from "./usePrefs";

export interface UsePasswordGenerator {
	settings: GeneratorSettings;
	/** Change one setting. Regenerates immediately; the new settings are persisted shortly after. */
	set<K extends keyof GeneratorSettings>(key: K, value: GeneratorSettings[K]): void;
	/** The current candidate. Empty until the first generation lands. */
	value: string;
	regenerate: () => void;
}

/** Field-by-field, so a re-render that produced an equal object doesn't count as a change. */
function same(a: GeneratorSettings, b: GeneratorSettings): boolean {
	return (Object.keys(a) as (keyof GeneratorSettings)[]).every((k) => a[k] === b[k]);
}

// Long enough that dragging the length slider persists once at the end rather than at every
// step, short enough to survive the panel being closed right after a change.
const PERSIST_DELAY_MS = 400;

/**
 * The generator's state: settings backed by the `generator` pref, and a candidate value kept in
 * step with them.
 *
 * Headless on purpose. PasswordGenerator renders it, but the one-tap regenerate in the entry
 * form only wants `generate(prefs.generator)`, and neither should own the other's settings.
 */
export function usePasswordGenerator(): UsePasswordGenerator {
	const { prefs, loaded, update } = usePrefs();
	const [settings, setSettings] = useState<GeneratorSettings>(prefs.generator);
	const [value, setValue] = useState("");
	// Prefs load async. Adopt the stored settings once they arrive, but only until the user has
	// touched something, so a late read can't overwrite what they just picked.
	const adopted = useRef(false);

	useEffect(() => {
		if (adopted.current || !loaded) return;
		adopted.current = true;
		setSettings(prefs.generator);
	}, [loaded, prefs.generator]);

	// Sequence number: passphrase mode awaits the wordlist chunk, so a slow first draw could
	// otherwise land on top of a later one and show a value the settings no longer describe.
	const seq = useRef(0);
	const regenerate = useCallback(() => {
		const id = ++seq.current;
		void generate(settings).then((next) => {
			if (seq.current === id) setValue(next);
		});
	}, [settings]);

	useEffect(regenerate, [regenerate]);

	// Settings waiting out the debounce. Held in a ref as well so unmounting can flush them:
	// picking a length and hitting Use straight away closes the panel inside the delay, and the
	// setting the user just chose would otherwise be the one thing the session failed to keep.
	const pending = useRef<GeneratorSettings | null>(null);
	const updateRef = useRef(update);
	useEffect(() => {
		updateRef.current = update;
	}, [update]);

	useEffect(() => {
		if (!adopted.current || same(settings, prefs.generator)) return;
		pending.current = settings;
		const id = setTimeout(() => {
			pending.current = null;
			void update("generator", settings);
		}, PERSIST_DELAY_MS);
		return () => clearTimeout(id);
	}, [settings, prefs.generator, update]);

	useEffect(
		() => () => {
			if (pending.current) void updateRef.current("generator", pending.current);
		},
		[],
	);

	const set = useCallback<UsePasswordGenerator["set"]>((key, next) => {
		adopted.current = true;
		setSettings((s) => ({ ...s, [key]: next }));
	}, []);

	return { settings, set, value, regenerate };
}
