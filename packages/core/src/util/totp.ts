import * as OTPAuth from "otpauth";

/** A TOTP generator plus issuer/account (blank when parsed from a bare secret). */
export interface ParsedTotp {
	totp: OTPAuth.TOTP;
	issuer: string;
	account: string;
	/** A Steam Guard key: `totp.generate()` yields Steam's 5-character code. */
	steam: boolean;
}

const STEAM_ALPHABET = "23456789BCDFGHJKMNPQRTVWXY";

/** Steam Guard: SHA-1, a 30 s step, and 5 characters from Steam's alphabet instead of digits. */
class SteamTotp extends OTPAuth.TOTP {
	constructor(config: { secret: OTPAuth.Secret; issuer: string; label: string }) {
		// 10 digits is the whole 31-bit truncated value, which generate() re-encodes.
		super({ ...config, algorithm: "SHA1", digits: 10, period: 30 });
	}

	override generate(opts?: { timestamp?: number }): string {
		let n = Number(super.generate(opts));
		let code = "";
		for (let i = 0; i < 5; i++) {
			code += STEAM_ALPHABET[n % 26];
			n = Math.floor(n / 26);
		}
		return code;
	}
}

function secretFromBase32(value: string | undefined): OTPAuth.Secret | null {
	const clean = value?.replace(/[\s-]/g, "").toUpperCase();
	return clean && !/^=*$/.test(clean) ? OTPAuth.Secret.fromBase32(clean) : null;
}

function decodeLoosely(s: string): string {
	try {
		return decodeURIComponent(s);
	} catch {
		return s;
	}
}

/**
 * Read an `otpauth://` URI the way Android and iOS autofill do (Totp.kt, Totp.swift) rather than
 * by the strict key-URI grammar, which refuses URIs other apps export: an empty label, a spaced
 * secret, `period=30.0`, a `?` inside a value. #204.
 */
function parseOtpauth(raw: string): ParsedTotp | null {
	const url = new URL(raw);
	const kind = url.host.toLowerCase();
	const params = new Map<string, string>();
	for (const [k, v] of url.searchParams) params.set(k.toLowerCase(), v);
	const steam = kind === "steam" || params.get("encoder")?.toLowerCase() === "steam";
	if (kind !== "totp" && !steam) return null;

	const secret = secretFromBase32(params.get("secret"));
	if (!secret) return null;
	const label = decodeLoosely(url.pathname.replace(/^\//, ""));
	const colon = label.indexOf(":");
	const account = colon < 0 ? label : label.slice(colon + 1).trim();
	const issuer = params.get("issuer") || (colon < 0 ? "" : label.slice(0, colon));
	if (steam)
		return { totp: new SteamTotp({ secret, issuer, label: account }), issuer, account, steam };

	const period = Number(params.get("period") ?? 30);
	const digits = Number(params.get("digits") ?? 6);
	// The dynamic truncation yields 31 bits, so more than 10 digits is meaningless.
	if (
		!Number.isInteger(period) ||
		period < 1 ||
		!Number.isInteger(digits) ||
		digits < 1 ||
		digits > 10
	)
		return null;
	// The constructor canonicalizes the algorithm ("sha-256" -> SHA256) and throws on an unknown one.
	const algorithm = params.get("algorithm") ?? "SHA1";
	const totp = new OTPAuth.TOTP({ secret, issuer, label: account, algorithm, digits, period });
	return { totp, issuer, account, steam };
}

/**
 * Parse a stored key into a TOTP generator. Accepts an `otpauth://totp/...` URI, a Steam Guard key
 * (`steam://<secret>`, `otpauth://steam/...` or `encoder=steam`), or a bare base32 secret; returns
 * null for anything else (HOTP, migration blobs, garbage) so callers can show an "invalid key" state.
 */
export function parseTotp(input: string | undefined | null): ParsedTotp | null {
	const raw = input?.trim();
	if (!raw) return null;
	try {
		if (/^otpauth:\/\//i.test(raw)) return parseOtpauth(raw);
		if (/^steam:\/\//i.test(raw)) {
			const secret = secretFromBase32(raw.slice("steam://".length));
			if (!secret) return null;
			return {
				totp: new SteamTotp({ secret, issuer: "Steam", label: "" }),
				issuer: "Steam",
				account: "",
				steam: true,
			};
		}
		const secret = secretFromBase32(raw);
		if (!secret) return null;
		// RFC 6238 defaults for a bare secret.
		const totp = new OTPAuth.TOTP({ secret, algorithm: "SHA1", digits: 6, period: 30 });
		return { totp, issuer: "", account: "", steam: false };
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
