const crypto = globalThis.crypto;

/** True if `password`'s SHA-1 appears in the HIBP range API (k-anonymity). Throws on network failure. */
export async function isPasswordLeaked(password: string) {
	if (typeof password !== "string") throw new Error("Password must be a string");

	const hashedPassword = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(password));
	const hashedPasswordString = Array.from(new Uint8Array(hashedPassword))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	const firstFive = hashedPasswordString.substring(0, 5).toUpperCase();
	const response = await fetch(`https://api.pwnedpasswords.com/range/${firstFive}`, {
		// Tells HIBP to pad the response set so an on-path observer can't
		// infer which range was actually queried. No-op on the result.
		headers: { "Add-Padding": "true" },
	});
	const data = await response.text();

	return data.includes(hashedPasswordString.substring(5).toUpperCase());
}

/** Check a password against HIBP. Returns undefined on any failure so callers fail-open (not "safe"). */
export async function checkPasswordBreach(
	password: string,
): Promise<{ leaked: boolean; checkedAt: number } | undefined> {
	if (!password) return undefined;
	try {
		const leaked = await isPasswordLeaked(password);
		return { leaked, checkedAt: Date.now() };
	} catch {
		return undefined;
	}
}
