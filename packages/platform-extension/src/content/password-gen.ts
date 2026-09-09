// Where a signup suggestion's password comes from.
//
// The background generates it, since that is the side that can read the user's generator
// settings; one rides along on every autofill query, and this module holds it until the
// suggestion is drawn. The local generator below is the fallback for when none arrived (an
// orphaned content script, a background too old to send one), so a sleeping worker costs the
// user a plain password rather than the suggestion itself.
//
// It stays a hand-rolled copy of the core generator's defaults rather than an import: the
// content script is a flat bundle with no cross-package runtime imports.

import { safeRequest } from "./lifecycle";

const CHARSET =
	"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()_+-=[]{}|;:,.<>?";
const LENGTH = 20;

/** A `LENGTH`-char password via unbiased rejection sampling over `CHARSET`. */
export function generatePassword(): string {
	const n = CHARSET.length;
	// n doesn't divide 256, so byte % n would bias; only accept bytes < floor(256/n)*n.
	const limit = Math.floor(256 / n) * n;
	const out: string[] = [];
	const buf = new Uint8Array(LENGTH);
	while (out.length < LENGTH) {
		crypto.getRandomValues(buf);
		for (let i = 0; i < buf.length && out.length < LENGTH; i++) {
			const b = buf[i]!;
			if (b < limit) out.push(CHARSET.charAt(b % n));
		}
	}
	return out.join("");
}

// One password in hand at a time. Overwritten by each query response, so what is held is always
// from the settings as they stand now.
let held: string | null = null;

/** Take the password carried on an autofill query response, if it carried one. */
export function holdGeneratedPassword(password: unknown): void {
	if (typeof password === "string" && password) held = password;
}

/**
 * A password for a suggestion: the one the background sent, or a locally generated fallback.
 *
 * Consuming it asks for a replacement, so a second signup field on the same page is served from
 * the user's settings too rather than falling back.
 */
export function takeGeneratedPassword(): string {
	const password = held;
	held = null;
	if (password) void refill();
	return password ?? generatePassword();
}

/** A fresh password from the user's settings, for the regenerate button. Falls back locally, so
 * the button always produces something. */
export async function requestGeneratedPassword(): Promise<string> {
	return (await ask()) ?? generatePassword();
}

async function refill(): Promise<void> {
	holdGeneratedPassword(await ask());
}

async function ask(): Promise<string | undefined> {
	const response = await safeRequest<{ ok: boolean; data?: { password?: unknown } }>({
		type: "GENERATE_PASSWORD",
	});
	if (!response?.ok) return undefined;
	const password = response.data?.password;
	return typeof password === "string" && password ? password : undefined;
}
