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
