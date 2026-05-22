import { passwordStrength } from "check-password-strength";

const crypto = globalThis.crypto;

export async function checkPassword(password: string) {
	return {
		strength: passwordStrength(password),
		isLeaked: await isPasswordLeaked(password),
	};
}

export function checkPasswordStrength(password: string) {
	return passwordStrength(password);
}

export async function isPasswordLeaked(password: string) {
	if (typeof password !== "string") throw new Error("Password must be a string");

	const hashedPassword = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(password));
	const hashedPasswordString = Array.from(new Uint8Array(hashedPassword))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	const firstFive = hashedPasswordString.substring(0, 5).toUpperCase();
	const response = await fetch(`https://api.pwnedpasswords.com/range/${firstFive}`);
	const data = await response.text();

	return data.includes(hashedPasswordString.substring(5).toUpperCase());
}

export function isPasswordLeakedSync(
	password: string,
	callback: (error: Error | null, isLeaked: boolean) => void,
) {
	if (typeof password !== "string") {
		callback(new Error("Password must be a string"), false);
		return;
	}

	crypto.subtle
		.digest("SHA-1", new TextEncoder().encode(password))
		.catch((error) => callback(error, false))
		.then((hashedPassword) => {
			const hashedPasswordString = Array.from(new Uint8Array(hashedPassword as ArrayBuffer))
				.map((b) => b.toString(16).padStart(2, "0"))
				.join("");
			const firstFive = hashedPasswordString.substring(0, 5).toUpperCase();
			fetch(`https://api.pwnedpasswords.com/range/${firstFive}`)
				.then((response) => response.text())
				.then((data) =>
					callback(null, data.includes(hashedPasswordString.substring(5).toUpperCase())),
				)
				.catch((error) => callback(error, false));
		});
}
