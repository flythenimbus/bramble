import { canonicalRosterEntry, decodeRoster, type RosterEntry } from "@core/sync/roster";
import { describe, expect, it, vi } from "vitest";

// Regression guard for the Firefox-inviter fix: the enroll HOST must add a freshly-joined device to
// the LOCAL roster itself (admission-signing it when it can), not lean on the popup — which on
// Firefox's event page can be gone when enrollment finishes, so the joiner gets rejected ("not in
// roster") when it reconnects for ongoing sync. See offscreen-core `addEnrolledToLocalRoster` and
// docs/multiple-vaults.md.

// Only the admission-signed path touches the wasm; stub roster_admission_sign deterministically.
vi.mock("./wasm-loader", () => ({
	loadWasm: async () => ({
		roster_admission_sign: (_password: string, _saltB64: string, message: string) =>
			`sig(${message})`,
	}),
}));

import { addEnrolledToLocalRoster } from "./offscreen-core";

const JOINER: RosterEntry = {
	id: "joiner-id",
	publicKey: "joinerPub",
	label: "Joiner",
	addedAt: 0,
	hlc: { wall: 1000, counter: 0, node: "joiner-id" },
};

function captureBridge() {
	const pushed: string[] = [];
	const vaults: string[] = [];
	return {
		pushed,
		vaults,
		bridge: {
			fetchLocalPayload: async () => "",
			pushRemotePayload: async () => {},
			fetchLocalRoster: async () => "",
			pushRemoteRoster: async (vaultId: string, rosterJson: string) => {
				vaults.push(vaultId);
				pushed.push(rosterJson);
			},
		},
	};
}

describe("addEnrolledToLocalRoster (host-side roster add on enroll)", () => {
	it("admission-signs the joiner and pushes it into the roster", async () => {
		const { pushed, vaults, bridge } = captureBridge();
		await addEnrolledToLocalRoster(
			bridge,
			"vault-a",
			{ password: "hunter2", saltB64: "SALT", adminId: "inviter-id" },
			JSON.stringify(JOINER),
		);
		expect(pushed).toHaveLength(1);
		const dev = decodeRoster(pushed[0]!).devices.find((d) => d.publicKey === "joinerPub");
		expect(dev).toBeDefined();
		// Into the roster of the vault that sent the invite, whichever vault is active by now.
		expect(vaults).toEqual(["vault-a"]);
		// The admission the host produces must match what a peer verifies: our id + a sig over the
		// joiner's canonical entry (the same string admission-verification recomputes).
		expect(dev?.admission).toEqual({
			by: "inviter-id",
			sig: `sig(${canonicalRosterEntry(JOINER)})`,
		});
	});

	it("pushes the joiner unsigned when this device can't admit (security-key inviter)", async () => {
		const { pushed, bridge } = captureBridge();
		await addEnrolledToLocalRoster(bridge, "vault-a", undefined, JSON.stringify(JOINER));
		expect(pushed).toHaveLength(1);
		const dev = decodeRoster(pushed[0]!).devices.find((d) => d.publicKey === "joinerPub");
		expect(dev).toBeDefined();
		expect(dev?.admission).toBeUndefined();
	});

	it("swallows a malformed enrolled entry without pushing or throwing", async () => {
		const { pushed, bridge } = captureBridge();
		await expect(
			addEnrolledToLocalRoster(bridge, "vault-a", undefined, "definitely not json"),
		).resolves.toBeUndefined();
		expect(pushed).toHaveLength(0);
	});
});
