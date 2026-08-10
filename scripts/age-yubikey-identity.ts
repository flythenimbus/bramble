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

export function yubiKeyIdentity(): string {
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

function listSlots(): { serial: string; slot: string }[] {
	const listed = execFileSync("age-plugin-yubikey", ["--list"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	return [...listed.matchAll(/Serial:\s*(\d+),\s*Slot:\s*(\d+)/g)].map((m) => ({
		serial: m[1] as string,
		slot: m[2] as string,
	}));
}
