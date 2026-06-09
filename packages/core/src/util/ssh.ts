/**
 * Best-effort SSH key algorithm from the public key's type token, falling back
 * to the private key's PEM header. Display-only, never used for crypto.
 */
export function deriveKeyType(publicKey: string, privateKey: string): string | undefined {
	const token = publicKey.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
	if (token.includes("ed25519")) return "ed25519";
	if (token === "ssh-rsa") return "rsa";
	if (token.startsWith("ecdsa-sha2") || token.startsWith("sk-ecdsa")) return "ecdsa";
	if (token === "ssh-dss") return "dsa";
	if (/BEGIN OPENSSH PRIVATE KEY/.test(privateKey)) return "openssh";
	if (/BEGIN RSA PRIVATE KEY/.test(privateKey)) return "rsa";
	if (/BEGIN EC PRIVATE KEY/.test(privateKey)) return "ecdsa";
	if (/BEGIN DSA PRIVATE KEY/.test(privateKey)) return "dsa";
	return undefined;
}

/**
 * SHA-256 fingerprint of an OpenSSH public key (`SHA256:<base64-no-padding>`),
 * matching `ssh-keygen -lf`. Hashes the decoded middle blob, not the algo
 * prefix or comment. Returns undefined for unparseable input.
 */
export async function sshFingerprint(publicKey: string): Promise<string | undefined> {
	const blob = publicKey.trim().split(/\s+/)[1];
	if (!blob) return undefined;
	let bytes: Uint8Array<ArrayBuffer>;
	try {
		const decoded = atob(blob);
		// Allocate the backing ArrayBuffer so the type narrows to
		// Uint8Array<ArrayBuffer>: digest's BufferSource rejects the broader
		// ArrayBufferLike (possible SharedArrayBuffer) since TS 5.7.
		bytes = new Uint8Array(new ArrayBuffer(decoded.length));
		for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
	} catch {
		return undefined;
	}
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	let bin = "";
	for (let i = 0; i < digest.length; i++) bin += String.fromCharCode(digest[i] ?? 0);
	return `SHA256:${btoa(bin).replace(/=+$/, "")}`;
}
