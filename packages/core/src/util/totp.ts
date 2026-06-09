import * as OTPAuth from "otpauth";

/** A TOTP generator plus issuer/account (blank when parsed from a bare secret). */
export interface ParsedTotp {
	totp: OTPAuth.TOTP;
	issuer: string;
	account: string;
}

/**
 * Parse a stored key into a TOTP generator. Accepts an `otpauth://totp/...` URI
 * or a bare base32 secret; returns null for anything else (HOTP, migration
 * blobs, garbage) so callers can show an "invalid key" state.
 */
export function parseTotp(input: string | undefined | null): ParsedTotp | null {
	const raw = input?.trim();
	if (!raw) return null;
	try {
		if (/^otpauth:\/\//i.test(raw)) {
			const parsed = OTPAuth.URI.parse(raw);
			// URI.parse also yields HOTP; we only generate TOTP.
			if (!(parsed instanceof OTPAuth.TOTP)) return null;
			return { totp: parsed, issuer: parsed.issuer, account: parsed.label };
		}
		const secret = OTPAuth.Secret.fromBase32(raw.replace(/[\s-]/g, "").toUpperCase());
		// RFC 6238 defaults for a bare secret.
		const totp = new OTPAuth.TOTP({ secret, algorithm: "SHA1", digits: 6, period: 30 });
		return { totp, issuer: "", account: "" };
	} catch {
		return null;
	}
}

/** Current code plus whole seconds left in its time-step, for a given clock (ms, defaults to now). */
export function totpAt(
	totp: OTPAuth.TOTP,
	now: number = Date.now(),
): { code: string; secondsRemaining: number } {
	const code = totp.generate({ timestamp: now });
	const secondsRemaining = totp.period - (Math.floor(now / 1000) % totp.period);
	return { code, secondsRemaining };
}
