import { readFileSync } from "node:fs";
import init, {
	change_password,
	decrypt_entry,
	encrypt_entry,
	generate_salt,
	is_locked,
	lock,
	unlock,
	verifier_for,
} from "../platform-extension/public/wasm/vault_crypto.js";

const wasmBytes = readFileSync(
	new URL("../platform-extension/public/wasm/vault_crypto_bg.wasm", import.meta.url),
);
await init({ module_or_path: wasmBytes });

const toHex = (bytes: Uint8Array) =>
	Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

const assertEq = (label: string, a: unknown, b: unknown) => {
	if (a !== b) throw new Error(`${label}: expected ${b}, got ${a}`);
	console.log(`  ok  ${label}`);
};

const expectThrow = (label: string, fn: () => unknown) => {
	try {
		fn();
		throw new Error(`${label}: expected throw, none happened`);
	} catch (e) {
		console.log(`  ok  ${label} (threw: ${(e as Error).message})`);
	}
};

console.log("locks: starts locked");
assertEq("is_locked()", is_locked(), true);

console.log("unlock + lock cycle");
const salt = generate_salt();
unlock("hunter2", salt);
assertEq("is_locked() after unlock", is_locked(), false);
lock();
assertEq("is_locked() after lock", is_locked(), true);

console.log("encrypt while locked must fail");
expectThrow("encrypt_entry locked", () => encrypt_entry("{}"));

console.log("encrypt → decrypt roundtrip");
unlock("hunter2", salt);
const plain = JSON.stringify({
	site: "github.com",
	username: "me",
	password: "s3cr3t!",
	totp: "JBSWY3DPEHPK3PXP",
});
const enc = encrypt_entry(plain) as {
	ciphertext: string;
	iv: string;
	wrappedDek: string;
	dekIv: string;
};
const dec = decrypt_entry(enc.ciphertext, enc.iv, enc.wrappedDek, enc.dekIv);
assertEq("roundtrip plaintext", dec, plain);

console.log("verifier is deterministic for same key + magic");
const magic = new TextEncoder().encode("VLT1\x01");
const v1 = verifier_for(magic);
const v2 = verifier_for(magic);
assertEq("verifier length", v1.length, 32);
assertEq("verifier deterministic", toHex(v1), toHex(v2));

console.log("wrong password → different verifier");
const wrongVerifier = (() => {
	lock();
	unlock("wrong-password", salt);
	const v = verifier_for(magic);
	lock();
	unlock("hunter2", salt);
	return v;
})();
if (toHex(v1) === toHex(wrongVerifier)) {
	throw new Error("wrong password produced same verifier");
}
console.log("  ok  wrong password → different verifier");

console.log("change_password re-wraps DEKs, ciphertext unchanged");
const newSalt = generate_salt();
const rewrapped = change_password("new-hunter3", newSalt, [enc]) as Array<{
	ciphertext: string;
	iv: string;
	wrappedDek: string;
	dekIv: string;
}>;
assertEq("entries count", rewrapped.length, 1);
assertEq("ciphertext unchanged", rewrapped[0]!.ciphertext, enc.ciphertext);
assertEq("iv unchanged", rewrapped[0]!.iv, enc.iv);
if (rewrapped[0]!.wrappedDek === enc.wrappedDek) {
	throw new Error("wrappedDek did not change after password change");
}
console.log("  ok  wrappedDek changed");

const dec2 = decrypt_entry(
	rewrapped[0]!.ciphertext,
	rewrapped[0]!.iv,
	rewrapped[0]!.wrappedDek,
	rewrapped[0]!.dekIv,
);
assertEq("decrypt after password change", dec2, plain);

console.log("\nALL CHECKS PASSED");
