// Client-side strong-password generator for the signup suggestion. Mirrors the
// app's randomPassword() (core/app/entry-modes/login.tsx); duplicated here so the
// content script stays a flat bundle with no cross-package runtime imports.

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
