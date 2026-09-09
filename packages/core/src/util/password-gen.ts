// The app's password generator: the settings and the generators themselves. Pure and
// platform-free (crypto.getRandomValues is the only ambient dependency), so the UI in
// PasswordGenerator.tsx and the one-tap regenerate in the entry form share one implementation
// and one set of defaults.

export type GeneratorMode = "password" | "passphrase" | "pin";

/** Everything the generator needs. Persisted as the `generator` pref, so treat stored values as
 * untrusted and run them through `normalizeGeneratorSettings` on the way in. */
export interface GeneratorSettings {
	mode: GeneratorMode;
	/** Character-mode length. */
	length: number;
	lowercase: boolean;
	uppercase: boolean;
	digits: boolean;
	symbols: boolean;
	/** Drop characters that read alike (0/O, 1/l/I) from every class. */
	avoidAmbiguous: boolean;
	/** Symbols to draw from. Editable because sites reject different subsets of them. */
	symbolSet: string;
	/** Passphrase word count. */
	words: number;
	/** Passphrase word separator. May be empty. */
	separator: string;
	capitalize: boolean;
	/** Append a digit to one random word, for sites that demand a number. */
	wordNumber: boolean;
	pinLength: number;
}

export const LOWERCASE = "abcdefghijklmnopqrstuvwxyz";
export const UPPERCASE = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
export const DIGITS = "0123456789";
/** Punctuation most sites accept. The user can narrow it for the ones that don't. */
export const DEFAULT_SYMBOLS = "!@#$%^&*()_+-=[]{}|;:,.<>?";
/** Glyph pairs that get misread off a screen or a printout. */
const AMBIGUOUS = "Il1|O0o";

export const MIN_LENGTH = 8;
export const MAX_LENGTH = 128;
export const MIN_WORDS = 3;
export const MAX_WORDS = 12;
export const MIN_PIN = 4;
export const MAX_PIN = 12;
/** Longest separator worth allowing; it is a joiner, not a field. */
const MAX_SEPARATOR = 3;

export const DEFAULT_GENERATOR_SETTINGS: GeneratorSettings = {
	mode: "password",
	length: 20,
	lowercase: true,
	uppercase: true,
	digits: true,
	symbols: true,
	avoidAmbiguous: false,
	symbolSet: DEFAULT_SYMBOLS,
	words: 5,
	separator: "-",
	capitalize: false,
	wordNumber: false,
	pinLength: 6,
};

function clamp(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * A uniform integer in [0, bound), by rejection sampling.
 *
 * `getRandomValues() % bound` is biased whenever bound doesn't divide 2^32: the low residues
 * come up more often. Discarding the short tail above the last whole multiple removes it.
 */
function randomInt(bound: number): number {
	if (bound <= 1) return 0;
	const limit = Math.floor(0x100000000 / bound) * bound;
	const buf = new Uint32Array(1);
	for (;;) {
		crypto.getRandomValues(buf);
		const n = buf[0] as number;
		if (n < limit) return n % bound;
	}
}

function pick(chars: string): string {
	return chars.charAt(randomInt(chars.length));
}

/** Fisher-Yates with unbiased indices. In place. */
function shuffle<T>(items: T[]): T[] {
	for (let i = items.length - 1; i > 0; i--) {
		const j = randomInt(i + 1);
		[items[i], items[j]] = [items[j] as T, items[i] as T];
	}
	return items;
}

function withoutAmbiguous(chars: string): string {
	return [...chars].filter((c) => !AMBIGUOUS.includes(c)).join("");
}

/**
 * The character classes in play, each already filtered for ambiguity.
 *
 * Returns them separately rather than concatenated because each enabled class contributes one
 * guaranteed character: "include digits" that only makes digits *possible* still produces
 * digit-free passwords, which sites with a "must contain a number" rule then reject.
 *
 * Never empty. A settings object with every class off would otherwise generate nothing, so
 * lowercase stands in; the UI also refuses to let the last class be turned off.
 */
export function characterClasses(settings: GeneratorSettings): string[] {
	const sets: string[] = [];
	const filter = (chars: string) => (settings.avoidAmbiguous ? withoutAmbiguous(chars) : chars);
	if (settings.lowercase) sets.push(filter(LOWERCASE));
	if (settings.uppercase) sets.push(filter(UPPERCASE));
	if (settings.digits) sets.push(filter(DIGITS));
	if (settings.symbols) {
		const symbols = filter(settings.symbolSet.trim() || DEFAULT_SYMBOLS);
		if (symbols) sets.push(symbols);
	}
	const usable = sets.filter((s) => s.length > 0);
	return usable.length > 0 ? usable : [LOWERCASE];
}

/**
 * A character password (or a PIN, which is the digits-only case).
 *
 * One character from each enabled class is placed first and the whole result shuffled, so the
 * class minimums hold by construction instead of by retrying until they happen to.
 */
export function generatePassword(settings: GeneratorSettings): string {
	if (settings.mode === "pin") {
		const length = clamp(settings.pinLength, MIN_PIN, MAX_PIN);
		// Ambiguity filtering is deliberately not applied: a PIN without 0 or 1 is a 4-digit
		// keypad the user then can't type what they expect into.
		return Array.from({ length }, () => pick(DIGITS)).join("");
	}
	const sets = characterClasses(settings);
	const length = clamp(settings.length, MIN_LENGTH, MAX_LENGTH);
	const pool = sets.join("");
	// One per class, truncated if the length can't seat them all (only reachable if MIN_LENGTH
	// ever drops below the class count).
	const out = sets.slice(0, length).map(pick);
	while (out.length < length) out.push(pick(pool));
	return shuffle(out).join("");
}

function capitalizeWord(word: string): string {
	return word.charAt(0).toUpperCase() + word.slice(1);
}

/** A passphrase drawn from `wordlist`. Words repeat: excluding the ones already drawn would
 * narrow each later choice, and a repeat in five words is rare anyway. */
export function generatePassphrase(
	settings: GeneratorSettings,
	wordlist: readonly string[],
): string {
	const count = clamp(settings.words, MIN_WORDS, MAX_WORDS);
	const words = Array.from({ length: count }, () => {
		const word = wordlist[randomInt(wordlist.length)] as string;
		return settings.capitalize ? capitalizeWord(word) : word;
	});
	if (settings.wordNumber) {
		const at = randomInt(words.length);
		words[at] = `${words[at]}${randomInt(10)}`;
	}
	return words.join(settings.separator);
}

/**
 * Generate for whichever mode is set. Async only because the wordlist is a lazy chunk: it is
 * 65 KB of source that a user who never opens passphrase mode should not pay for.
 *
 * Anywhere `import()` is not dependable (the extension's service worker) calls
 * generatePassword/generatePassphrase directly instead.
 */
export async function generate(settings: GeneratorSettings): Promise<string> {
	if (settings.mode !== "passphrase") return generatePassword(settings);
	const { effWordlist } = await import("./wordlist-eff");
	return generatePassphrase(settings, effWordlist());
}

function bool(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function num(value: unknown, min: number, max: number, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? clamp(value, min, max) : fallback;
}

/** Coerce a stored (or otherwise untrusted) value into usable settings, field by field. Anything
 * missing or malformed falls back to its default rather than failing the whole read. */
export function normalizeGeneratorSettings(raw: unknown): GeneratorSettings {
	const d = DEFAULT_GENERATOR_SETTINGS;
	if (!raw || typeof raw !== "object") return d;
	const r = raw as Record<string, unknown>;
	const mode: GeneratorMode =
		r.mode === "passphrase" || r.mode === "pin" || r.mode === "password" ? r.mode : d.mode;
	const symbolSet =
		typeof r.symbolSet === "string" && r.symbolSet.trim() ? r.symbolSet : d.symbolSet;
	const separator =
		typeof r.separator === "string" ? r.separator.slice(0, MAX_SEPARATOR) : d.separator;
	const settings: GeneratorSettings = {
		mode,
		length: num(r.length, MIN_LENGTH, MAX_LENGTH, d.length),
		lowercase: bool(r.lowercase, d.lowercase),
		uppercase: bool(r.uppercase, d.uppercase),
		digits: bool(r.digits, d.digits),
		symbols: bool(r.symbols, d.symbols),
		avoidAmbiguous: bool(r.avoidAmbiguous, d.avoidAmbiguous),
		symbolSet,
		words: num(r.words, MIN_WORDS, MAX_WORDS, d.words),
		separator,
		capitalize: bool(r.capitalize, d.capitalize),
		wordNumber: bool(r.wordNumber, d.wordNumber),
		pinLength: num(r.pinLength, MIN_PIN, MAX_PIN, d.pinLength),
	};
	// Every class off generates from lowercase anyway; store that rather than a setting whose
	// checkboxes would all read as unchecked.
	if (!settings.lowercase && !settings.uppercase && !settings.digits && !settings.symbols) {
		settings.lowercase = true;
	}
	return settings;
}
