import * as OTPAuth from "otpauth";

export interface ParsedTotp {
	totp: OTPAuth.TOTP;
	issuer: string;
	account: string;
}

export function parseTotp(input: string | undefined | null): ParsedTotp | null {
	const raw = input?.trim();
	if (!raw) return null;
	try {
		if (/^otpauth:\/\//i.test(raw)) {
			const parsed = OTPAuth.URI.parse(raw);
			if (!(parsed instanceof OTPAuth.TOTP)) return null;
			return { totp: parsed, issuer: parsed.issuer, account: parsed.label };
		}
		const secret = OTPAuth.Secret.fromBase32(raw.replace(/[\s-]/g, "").toUpperCase());
		const totp = new OTPAuth.TOTP({ secret, algorithm: "SHA1", digits: 6, period: 30 });
		return { totp, issuer: "", account: "" };
	} catch {
		return null;
	}
}

export function totpAt(
	totp: OTPAuth.TOTP,
	now: number = Date.now(),
): { code: string; secondsRemaining: number } {
	const code = totp.generate({ timestamp: now });
	const secondsRemaining = totp.period - (Math.floor(now / 1000) % totp.period);
	return { code, secondsRemaining };
}
