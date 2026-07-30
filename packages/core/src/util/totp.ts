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

/**
 * Build the `otpauth://totp/...` URI we store, from structured parts (a CXF TOTP
 * credential). Throws if the secret isn't valid base32.
 */
export function buildTotpUri(parts: {
	secret: string;
	issuer?: string;
	account?: string;
	digits?: number;
	period?: number;
	algorithm?: string;
}): string {
	const totp = new OTPAuth.TOTP({
		secret: OTPAuth.Secret.fromBase32(parts.secret.replace(/[\s-]/g, "").toUpperCase()),
		issuer: parts.issuer ?? "",
		label: parts.account || "account",
		algorithm: (parts.algorithm ?? "SHA1").toUpperCase(),
		digits: parts.digits ?? 6,
		period: parts.period ?? 30,
	});
	return totp.toString();
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
