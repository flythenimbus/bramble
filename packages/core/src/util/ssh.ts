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

//
//
export async function sshFingerprint(publicKey: string): Promise<string | undefined> {
	const blob = publicKey.trim().split(/\s+/)[1];
	if (!blob) return undefined;
	let bytes: Uint8Array<ArrayBuffer>;
	try {
		const decoded = atob(blob);
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
