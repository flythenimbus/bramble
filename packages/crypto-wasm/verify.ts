import { readFileSync } from "node:fs";
import init, {
	decrypt_entry,
	decrypt_with_vek,
	encrypt_entry,
	encrypt_with_vek,
	export_vek,
	generate_salt,
	generate_slot_id,
	generate_vek,
	is_locked,
	lock,
	rotate_vek,
	unlock_with_vek,
	unwrap_vek_password,
	verify_password_slot,
	wrap_vek_password,
} from "../platform-extension/public/wasm/vault_crypto.js";

const wasmBytes = readFileSync(
	new URL("../platform-extension/public/wasm/vault_crypto_bg.wasm", import.meta.url),
);
await init({ module_or_path: wasmBytes });

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

const MAGIC_VERSION = new Uint8Array([0x56, 0x4c, 0x54, 0x31, 0x02]);

console.log("locks: starts locked");
assertEq("is_locked()", is_locked(), true);

console.log("generate_vek loads VEK into memory");
const vek = generate_vek();
assertEq("is_locked() after generate_vek", is_locked(), false);
assertEq("export_vek roundtrips", export_vek(), vek);

console.log("wrap_vek_password produces a sealable slot");
const salt = generate_salt();
const slotId = generate_slot_id();
const slot = wrap_vek_password("hunter2", salt, slotId, MAGIC_VERSION) as {
	verifier: string;
	wrapIv: string;
	wrappedVek: string;
};

console.log("encrypt while unlocked works");
const plain = JSON.stringify({ site: "github.com", username: "me", password: "s3cr3t!" });
const enc = encrypt_entry(plain) as {
	ciphertext: string;
	iv: string;
	wrappedDek: string;
	dekIv: string;
};

console.log("lock + encrypt must fail");
lock();
assertEq("is_locked() after lock", is_locked(), true);
expectThrow("encrypt_entry locked", () => encrypt_entry("{}"));

console.log("unwrap_vek_password with wrong password returns false, leaves locked");
assertEq(
	"unwrap wrong pw",
	unwrap_vek_password(
		"wrong",
		salt,
		slotId,
		slot.verifier,
		slot.wrapIv,
		slot.wrappedVek,
		MAGIC_VERSION,
	),
	false,
);
assertEq("still locked", is_locked(), true);

console.log("unwrap_vek_password with right password unlocks");
assertEq(
	"unwrap right pw",
	unwrap_vek_password(
		"hunter2",
		salt,
		slotId,
		slot.verifier,
		slot.wrapIv,
		slot.wrappedVek,
		MAGIC_VERSION,
	),
	true,
);
assertEq("is_locked() after unwrap", is_locked(), false);
assertEq("VEK restored", export_vek(), vek);

console.log("decrypt roundtrip after unwrap");
const dec = decrypt_entry(enc.ciphertext, enc.iv, enc.wrappedDek, enc.dekIv);
assertEq("decrypted plaintext", dec, plain);

console.log("encrypt_with_vek / decrypt_with_vek roundtrip");
const outer = encrypt_with_vek("[]") as { iv: string; ciphertext: string };
assertEq("outer decrypts back", decrypt_with_vek(outer.iv, outer.ciphertext), "[]");

console.log("verify_password_slot — constant-time check while unlocked");
assertEq(
	"right pw ok",
	verify_password_slot("hunter2", salt, slotId, slot.verifier, MAGIC_VERSION),
	true,
);
assertEq(
	"wrong pw rejected",
	verify_password_slot("wrong", salt, slotId, slot.verifier, MAGIC_VERSION),
	false,
);

console.log("wrap_vek_password under fresh credentials: same VEK, new slot");
const newSalt = generate_salt();
const newSlot = wrap_vek_password("new-hunter3", newSalt, slotId, MAGIC_VERSION) as {
	verifier: string;
	wrapIv: string;
	wrappedVek: string;
};
lock();
assertEq(
	"unwrap with new pw",
	unwrap_vek_password(
		"new-hunter3",
		newSalt,
		slotId,
		newSlot.verifier,
		newSlot.wrapIv,
		newSlot.wrappedVek,
		MAGIC_VERSION,
	),
	true,
);
assertEq("VEK unchanged after rotation", export_vek(), vek);
const dec2 = decrypt_entry(enc.ciphertext, enc.iv, enc.wrappedDek, enc.dekIv);
assertEq("entry still decrypts after rotation", dec2, plain);

console.log("session-resume: unlock_with_vek restores VEK");
lock();
unlock_with_vek(vek);
assertEq("is_locked() after unlock_with_vek", is_locked(), false);
assertEq("VEK matches", export_vek(), vek);

console.log("rotate_vek: produces a new VEK, old entries no longer decrypt");
const oldEntry = encrypt_entry(plain) as {
	ciphertext: string;
	iv: string;
	wrappedDek: string;
	dekIv: string;
};
const preRotateVek = export_vek();
const rotatedVek = rotate_vek();
if (rotatedVek === preRotateVek) throw new Error("rotate_vek returned the same VEK");
assertEq("export_vek matches rotated", export_vek(), rotatedVek);
expectThrow("old entry fails to decrypt under new VEK", () =>
	decrypt_entry(oldEntry.ciphertext, oldEntry.iv, oldEntry.wrappedDek, oldEntry.dekIv),
);
const newEntry = encrypt_entry(plain) as {
	ciphertext: string;
	iv: string;
	wrappedDek: string;
	dekIv: string;
};
assertEq(
	"new entry decrypts under new VEK",
	decrypt_entry(newEntry.ciphertext, newEntry.iv, newEntry.wrappedDek, newEntry.dekIv),
	plain,
);

console.log("rotate_vek refuses to run on a locked vault");
lock();
expectThrow("rotate_vek locked", () => rotate_vek());

console.log("\nALL CHECKS PASSED");
