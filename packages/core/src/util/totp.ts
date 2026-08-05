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

/** Why a scanned QR couldn't become an authenticator key. */
export type QrScanFailure =
	// Nothing decoded: no QR on screen, or it wasn't legible.
	| "not-found"
	// A vendor's own authenticator-activation link, which carries no shared secret.
	| "vendor-app"
	// An authenticator export blob holding several accounts, not a setup code.
	| "migration"
	// Decoded cleanly, but it isn't an authenticator setup code at all.
	| "not-totp";

export interface QrScanResult {
	/** The usable key, set only when the QR parsed as a TOTP. */
	uri?: string;
	failure?: QrScanFailure;
	/** Human name of the vendor app, when `failure` is "vendor-app". */
	vendor?: string;
}

// Links that decode perfectly but bind an account to one specific app rather
// than handing over a shared secret. Worth naming individually: each has its own
// non-obvious way out, and Microsoft's is what you get by DEFAULT on the MS 2FA
// page, so "no QR found" sends people hunting for the wrong problem. Grow this
// as real ones turn up.
const VENDOR_ACTIVATION: Array<{ re: RegExp; vendor: string }> = [
	{ re: /authenticatorApp\/activateAccount/i, vendor: "Microsoft Authenticator" },
];

/**
 * Classify a decoded QR payload so the UI can say what actually went wrong.
 * "Nothing decoded" and "decoded, but it's a Microsoft Authenticator link" are
 * very different problems, and collapsing them sends the user to check
 * visibility and zoom when the QR was read perfectly.
 */
export function classifyScannedQr(decoded: string | null | undefined): QrScanResult {
	const raw = decoded?.trim();
	if (!raw) return { failure: "not-found" };
	if (parseTotp(raw)) return { uri: raw };
	if (/^otpauth-migration:\/\//i.test(raw)) return { failure: "migration" };
	for (const { re, vendor } of VENDOR_ACTIVATION) {
		if (re.test(raw)) return { failure: "vendor-app", vendor };
	}
	return { failure: "not-totp" };
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
