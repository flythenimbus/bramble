import { describe, expect, it } from "vitest";
import {
	ApplyRemoteMsgSchema,
	EnrollInviteMsgSchema,
	EnrollJoinMsgSchema,
	RosterSyncMsgSchema,
	SyncEventMsgSchema,
	SyncStatusMsgSchema,
} from "./messages";

const hlc = { wall: 1, counter: 0, node: "n" };
const rosterEntry = { id: "d1", publicKey: "pk", label: "phone", addedAt: 0, hlc };
const roster = { devices: [rosterEntry], revoked: [] };
const entries = { entries: [], tombstones: [] };

describe("RosterSyncMsgSchema", () => {
	it("accepts a well-formed roster-sync payload", () => {
		const ok = {
			relayUrl: "wss://r",
			groupKeyB64: "g",
			roster,
			devicePrivB64: "priv",
			devicePubB64: "pub",
		};
		expect(RosterSyncMsgSchema.parse(ok)).toEqual(ok);
	});

	it("rejects a payload missing devicePubB64", () => {
		const bad = { relayUrl: "wss://r", groupKeyB64: "g", roster, devicePrivB64: "priv" };
		expect(RosterSyncMsgSchema.safeParse(bad).success).toBe(false);
	});

	it("rejects a malformed roster", () => {
		const bad = {
			relayUrl: "wss://r",
			groupKeyB64: "g",
			roster: { devices: [{ id: "" }], revoked: [] },
			devicePrivB64: "priv",
			devicePubB64: "pub",
		};
		expect(RosterSyncMsgSchema.safeParse(bad).success).toBe(false);
	});
});

describe("EnrollInviteMsgSchema", () => {
	it("accepts an inviter payload", () => {
		const ok = {
			relayUrl: "wss://r",
			groupKeyB64: "g",
			psk: "p",
			devicePrivB64: "priv",
			roster,
			entries,
		};
		expect(EnrollInviteMsgSchema.parse(ok)).toEqual(ok);
	});

	it("rejects an inviter payload missing entries", () => {
		const bad = { relayUrl: "wss://r", groupKeyB64: "g", psk: "p", devicePrivB64: "priv", roster };
		expect(EnrollInviteMsgSchema.safeParse(bad).success).toBe(false);
	});
});

describe("EnrollJoinMsgSchema", () => {
	const base = {
		relayUrl: "wss://r",
		groupKeyB64: "g",
		psk: "p",
		devicePrivB64: "priv",
		inviterPub: "ipub",
		password: "pw",
	};

	it("accepts a password joiner payload", () => {
		const ok = { ...base, ownEntry: rosterEntry };
		expect(EnrollJoinMsgSchema.parse(ok)).toEqual(ok);
	});

	it("drops a webauthn block, so the removed keyless join cannot be driven through it", () => {
		// Joining by key is gone. Zod strips unknown keys rather than rejecting, so a payload
		// carrying one still parses - but the field does not survive, and the receiving side has
		// no option to read it into. Asserted because silence here would look like acceptance.
		const sent = {
			relayUrl: "wss://r",
			groupKeyB64: "g",
			psk: "p",
			devicePrivB64: "priv",
			inviterPub: "ipub",
			ownEntry: rosterEntry,
			webauthn: { hmacSecretB64: "h", credentialIdB64: "c", saltB64: "s" },
		};
		const parsed = EnrollJoinMsgSchema.parse(sent);
		expect(parsed).not.toHaveProperty("webauthn");
	});

	it("rejects a joiner payload with a malformed ownEntry", () => {
		const bad = { ...base, ownEntry: { id: "d1", label: "phone", addedAt: 0, hlc } }; // no publicKey
		expect(EnrollJoinMsgSchema.safeParse(bad).success).toBe(false);
	});
});

describe("ApplyRemoteMsgSchema", () => {
	it("requires a payloadJson string", () => {
		expect(ApplyRemoteMsgSchema.parse({ payloadJson: "{}" })).toEqual({ payloadJson: "{}" });
		expect(ApplyRemoteMsgSchema.safeParse({}).success).toBe(false);
		expect(ApplyRemoteMsgSchema.safeParse({ payloadJson: 1 }).success).toBe(false);
	});
});

describe("SyncEventMsgSchema", () => {
	it("accepts a joined event with the rebuilt blob", () => {
		const ok = { kind: "joined", vaultBlobB64: "blob", roster };
		expect(SyncEventMsgSchema.parse(ok)).toEqual(ok);
	});

	it("accepts an enrolled event with just an entry", () => {
		expect(SyncEventMsgSchema.parse({ kind: "enrolled", entryJson: "{}" })).toEqual({
			kind: "enrolled",
			entryJson: "{}",
		});
	});

	it("rejects an event without a kind", () => {
		expect(SyncEventMsgSchema.safeParse({ vaultBlobB64: "blob" }).success).toBe(false);
	});
});

describe("SyncStatusMsgSchema", () => {
	it("requires a status string", () => {
		expect(SyncStatusMsgSchema.parse({ status: "syncing" })).toEqual({ status: "syncing" });
		expect(SyncStatusMsgSchema.safeParse({}).success).toBe(false);
	});
});
