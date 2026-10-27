import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import init, {
	decrypt_entry,
	decrypt_with_vek,
	encrypt_entry,
	encrypt_with_vek,
	export_vek,
	FileOpenStream,
	FileSealStream,
	generate_salt,
	generate_slot_id,
	generate_vek,
	is_locked,
	KdbxWriter,
	lock,
	open_file_meta,
	open_kdbx4,
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

// Wrap the existing VEK under a new KEK (second authenticator) without rotating it.
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

// File attachments through the wasm-bindgen classes the extension's host drives. The property
// that matters is the one the host's atomicity rests on: the VEK is used by the constructor and
// never again, so a stream keeps working after the slot is cleared.
console.log("file streams: seal and open a file in chunks, with the VEK needed only to begin");
expectThrow("FileSealStream while locked", () => new FileSealStream("{}"));
unlock_with_vek(vek);
const CHUNK = 256 * 1024;
const fileBody = new Uint8Array(CHUNK + 1000).map((_, i) => i % 251);
const metaJson = JSON.stringify({ name: "scan.pdf", mime: "application/pdf" });
const sealStream = new FileSealStream(metaJson);
lock();
const sealedChunks = [
	sealStream.seal_next(fileBody.subarray(0, CHUNK), false),
	sealStream.seal_next(fileBody.subarray(CHUNK), true),
];
const record = sealStream.finish() as {
	hash: string;
	size: number;
	noncePrefix: string;
	wrappedFek: string;
	fekIv: string;
	metaBlob: string;
	metaIv: string;
};
sealStream.free();
const sealedBlob = Buffer.concat(sealedChunks);
assertEq("sealed size", record.size, fileBody.length + 2 * 16);
assertEq(
	"hash is over the sealed bytes",
	record.hash,
	createHash("sha256").update(sealedBlob).digest("hex"),
);
unlock_with_vek(vek);
assertEq(
	"metadata opens",
	open_file_meta(record.wrappedFek, record.fekIv, record.metaBlob, record.metaIv),
	metaJson,
);
const openStream = new FileOpenStream(
	record.wrappedFek,
	record.fekIv,
	record.noncePrefix,
	record.size,
);
lock();
assertEq("plaintext_len, before any chunk is open", openStream.plaintext_len(), fileBody.length);
const opened: Uint8Array[] = [];
for (let range = openStream.next_range(); range; range = openStream.next_range()) {
	const [offset, length] = range as unknown as [number, number];
	opened.push(openStream.open_next(sealedBlob.subarray(offset, offset + length)));
}
openStream.free();
assertEq("round trip", Buffer.compare(Buffer.concat(opened), Buffer.from(fileBody)), 0);

type KdbxEntry = {
	strings: { key: string; value: string; protected: boolean }[];
	binaries: { name: string; index: number }[];
};
type KdbxOpened = { entries: KdbxEntry[]; attachments: Uint8Array[] };

// KDBX4 export with an attachment, written in pieces as the extension's host does, through the
// same wasm-bindgen class. Read back by our own reader; KeePassXC is the e2e's check.
console.log("KdbxWriter: an attachment written in pieces, and the database opens");
const writer = new KdbxWriter("export-pw");
const pieces: Uint8Array[] = [writer.take()];
const ref = writer.begin_binary(fileBody.length);
writer.write_binary(fileBody.subarray(0, CHUNK));
pieces.push(writer.take());
writer.write_binary(fileBody.subarray(CHUNK));
pieces.push(writer.take());
expectThrow("an attachment longer than declared", () => writer.write_binary(new Uint8Array(1)));
pieces.push(
	writer.finish([
		{
			strings: [{ key: "Title", value: "Passport", protected: false }],
			binaries: [{ name: "scan.pdf", index: ref }],
		},
	]),
);
writer.free();
const reread = open_kdbx4(Buffer.concat(pieces), "export-pw") as KdbxOpened;
const exported = reread.entries;
assertEq("exported entry", exported[0]?.strings.find((x) => x.key === "Title")?.value, "Passport");
assertEq("its attachment is not read as a field", exported[0]?.strings.length, 1);
assertEq("and is read as an attachment", exported[0]?.binaries[0]?.name, "scan.pdf");
assertEq(
	"byte for byte",
	Buffer.compare(
		Buffer.from(reread.attachments[exported[0]?.binaries[0]?.index ?? -1] ?? []),
		Buffer.from(fileBody),
	),
	0,
);

// KDBX4 import through the real wasm-bindgen JS export, the same surface offscreen calls.
const kdbxField = (e: KdbxEntry | undefined, key: string) =>
	e?.strings.find((s) => s.key === key)?.value;
const kdbxByTitle = (es: KdbxEntry[], title: string) =>
	es.find((e) => kdbxField(e, "Title") === title);
const fixture = (name: string) =>
	new Uint8Array(readFileSync(new URL(`./tests/fixtures/${name}`, import.meta.url)));

console.log("open_kdbx4: opens a real KDBX4 file and decrypts protected values");
const kdbxEntries = (
	open_kdbx4(fixture("sample.kdbx"), "correct horse battery staple") as KdbxOpened
).entries;
assertEq("kdbx entry count", kdbxEntries.length, 2);
const gh = kdbxByTitle(kdbxEntries, "GitHub");
assertEq("kdbx GitHub password (protected, decrypted)", kdbxField(gh, "Password"), "hunter2");
assertEq(
	"kdbx password marked protected",
	gh?.strings.find((s) => s.key === "Password")?.protected,
	true,
);

console.log("open_kdbx4: opens with a key file");
const keyed = (
	open_kdbx4(fixture("sample-keyfile.kdbx"), "filevault", fixture("sample.keyx")) as KdbxOpened
).entries;

console.log("open_kdbx4: KeePassXC's attachments, on the entries that hold them");
const withFiles = open_kdbx4(fixture("attachments.kdbx"), "attach-pass") as KdbxOpened;
const scanRef = kdbxByTitle(withFiles.entries, "Passport")?.binaries.find(
	(b) => b.name === "scan.bin",
);
assertEq(
	"scan.bin byte for byte",
	Buffer.compare(
		Buffer.from(withFiles.attachments[scanRef?.index ?? -1] ?? []),
		Buffer.from(fixture("attachments-scan.bin")),
	),
	0,
);
assertEq("kdbx keyfile password", kdbxField(kdbxByTitle(keyed, "GitHub"), "Password"), "hunter2");

console.log("open_kdbx4: wrong password throws KDBX_WRONG_CREDENTIAL");
try {
	open_kdbx4(fixture("sample.kdbx"), "definitely wrong");
	throw new Error("expected open_kdbx4 to throw on wrong password");
} catch (e) {
	const msg = (e as Error).message;
	if (!msg.includes("KDBX_WRONG_CREDENTIAL"))
		throw new Error(`expected KDBX_WRONG_CREDENTIAL, got: ${msg}`);
	console.log("  ok  wrong kdbx password (threw KDBX_WRONG_CREDENTIAL)");
}

console.log("\nALL CHECKS PASSED");
