// The age identity stub for the YubiKey slot that holds Bramble's release keys.
//
// Split out because a bare `age-plugin-yubikey --identity` prints NOTHING on 0.5.1: the slot has
// to be named with --serial/--slot. It exits 0 while doing it, so the empty file lands on disk and
// the failure surfaces later as an unexplained `age -d` error, which is a bad half hour to spend
// during a release. Discovering the slot from --list keeps it working across YubiKeys.
//
// The stub is not key material. It points at a slot; decrypting still needs the physical key,
// its PIN, and a touch.

import { execFileSync } from "node:child_process";

/** Set these when more than one slot is configured and the wrong one would be picked. */
const SERIAL = process.env.AGE_YUBIKEY_SERIAL;
const SLOT = process.env.AGE_YUBIKEY_SLOT;

/** The slot these release keys live in, named explicitly when the YubiKey has more than one. */
function chooseSlot(): { serial: string; slot: string; recipient: string } {
	const slots = listSlots();
	if (slots.length === 0)
		throw new Error(
			"no age identity found on the YubiKey. Is it plugged in? See docs/release-signing.md",
		);

	let chosen = slots[0];
	if (SERIAL || SLOT)
		chosen = slots.find((s) => (!SERIAL || s.serial === SERIAL) && (!SLOT || s.slot === SLOT));
	// Guessing here would decrypt with the wrong key and report it as a corrupt file.
	if (!chosen)
		throw new Error(
			`no YubiKey slot matches AGE_YUBIKEY_SERIAL/SLOT. Available:\n${slots
				.map((s) => `  serial ${s.serial}, slot ${s.slot}`)
				.join("\n")}`,
		);
	if (slots.length > 1 && !SERIAL && !SLOT)
		console.error(
			`note: ${slots.length} age slots on this YubiKey; using serial ${chosen.serial}, slot ${chosen.slot}.\n` +
				"      Set AGE_YUBIKEY_SERIAL / AGE_YUBIKEY_SLOT to choose another.",
		);
	return chosen;
}

/**
 * The `age1yubikey1…` recipient to encrypt a new secret to, for the same slot that decrypts.
 * Encrypting needs neither PIN nor touch: it is a public key.
 */
export function yubiKeyRecipient(): string {
	const { serial, slot, recipient } = chooseSlot();
	if (!recipient)
		throw new Error(`age-plugin-yubikey listed no recipient for serial ${serial}, slot ${slot}`);
	return recipient;
}

export function yubiKeyIdentity(): string {
	const chosen = chooseSlot();

	const identity = execFileSync(
		"age-plugin-yubikey",
		["--identity", "--serial", chosen.serial, "--slot", chosen.slot],
		// Progress goes to stderr; only stdout is the stub.
		{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
	);
	if (!identity.includes("AGE-PLUGIN-YUBIKEY-"))
		throw new Error(`age-plugin-yubikey returned no identity for slot ${chosen.slot}`);
	return identity;
}

function listSlots(): { serial: string; slot: string; recipient: string }[] {
	const listed = execFileSync("age-plugin-yubikey", ["--list"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	// Split on the slot headers first, then look inside each block, rather than matching both in
	// one pass: a slot whose recipient line is missing would drop out of the list entirely, and the
	// identity lookup would report a YubiKey with no age identity on it.
	//
	// The recipient is an unlabelled line of its own under the `#` comments (0.5.1), so it is
	// matched by shape. The identity stub in the same block is uppercase AGE-PLUGIN-YUBIKEY-, so
	// there is nothing else here an `age1…` pattern can hit.
	const blocks = listed.matchAll(
		/Serial:\s*(\d+),\s*Slot:\s*(\d+)([\s\S]*?)(?=Serial:\s*\d+,\s*Slot:|$)/g,
	);
	return [...blocks].map((m) => ({
		serial: m[1] as string,
		slot: m[2] as string,
		recipient: /^\s*(age1\S+)\s*$/m.exec(m[3] as string)?.[1] ?? "",
	}));
}
