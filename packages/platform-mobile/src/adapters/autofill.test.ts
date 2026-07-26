import { PREF_AUTOFILL_QUICKTYPE } from "@core/hooks/usePrefs";
import type { IndexEntry } from "@core/index";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Everything setIndex touches: the native bridge, the VEK crypto, and the meta store the
// QuickType opt-in lives in. sync-manager is stubbed too (importing it would drag in the
// whole WebRTC/wasm stack for one constant).
const { bridge, meta } = vi.hoisted(() => ({
	bridge: {
		sync: vi.fn(async (_payload: unknown) => {}),
		clear: vi.fn(),
		setKeepUnlocked: vi.fn(),
	},
	meta: new Map<string, unknown>(),
}));

vi.mock("@capacitor/core", () => ({
	Capacitor: { getPlatform: () => "ios" },
	registerPlugin: () => bridge,
}));
vi.mock("@capacitor/device", () => ({ Device: { getInfo: async () => ({ osVersion: "18.0" }) } }));
vi.mock("../sync/sync-manager", () => ({ ACTIVE_VAULT_KEY: "active-vault" }));
vi.mock("./crypto", () => ({
	mobileCrypto: {
		encryptWithVek: async (plaintext: string) => ({ iv: "IV", ciphertext: plaintext }),
	},
}));
vi.mock("./storage", () => ({
	mobileStorage: {
		getMeta: async (k: string) => meta.get(k),
		// No blob in the test store: readPasswordSlot swallows the throw and returns undefined.
		readVaultBlob: async () => {
			throw new Error("no vault stored");
		},
	},
}));

const { mobileAutofill } = await import("./autofill");

function login(over: Partial<IndexEntry> = {}): IndexEntry {
	return {
		type: "login",
		id: "e1",
		name: "GitHub",
		username: "me@example.com",
		password: "pw",
		hostnames: ["github.com"],
		...over,
	} as IndexEntry;
}

/** The `sync` payload from the last setIndex call. */
function lastSync() {
	const call = bridge.sync.mock.calls.at(-1);
	if (!call) throw new Error("sync was not called");
	return call[0] as {
		identities?: { recordId: string; username: string; service: string }[];
		oneTimeCodeIdentities?: { recordId: string; label: string; service: string }[];
		ciphertext: string;
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	meta.clear();
});

// The seed rides the VEK-encrypted bundle (the extension generates the digits itself); only
// the identity metadata is ever cleartext, and only behind the opt-in.
describe("setIndex one-time-code identities", () => {
	it("publishes a code identity per host for logins with a TOTP key", async () => {
		meta.set(PREF_AUTOFILL_QUICKTYPE, true);
		await mobileAutofill.setIndex([
			login({
				totp: "otpauth://totp/x?secret=GEZDGNBVGY3TQOJQ",
				hostnames: ["github.com", "www.gist.github.com"],
			}),
		]);
		expect(lastSync().oneTimeCodeIdentities).toEqual([
			{ recordId: "e1", label: "me@example.com", service: "github.com" },
			{ recordId: "e1", label: "me@example.com", service: "gist.github.com" },
		]);
	});

	it("omits logins with no TOTP key, while still publishing their password identity", async () => {
		meta.set(PREF_AUTOFILL_QUICKTYPE, true);
		await mobileAutofill.setIndex([login()]);
		const sent = lastSync();
		expect(sent.oneTimeCodeIdentities).toEqual([]);
		expect(sent.identities).toHaveLength(1);
	});

	// The toggle is the privacy contract: with it off, nothing about which sites have 2FA
	// may reach the OS store in the clear.
	it("publishes nothing when the keyboard-suggestions opt-in is off", async () => {
		await mobileAutofill.setIndex([login({ totp: "GEZDGNBVGY3TQOJQ" })]);
		const sent = lastSync();
		expect(sent.oneTimeCodeIdentities).toEqual([]);
		expect(sent.identities).toEqual([]);
	});

	it("falls back to the entry name when the login has no username", async () => {
		meta.set(PREF_AUTOFILL_QUICKTYPE, true);
		await mobileAutofill.setIndex([login({ username: "", totp: "GEZDGNBVGY3TQOJQ" })]);
		expect(lastSync().oneTimeCodeIdentities).toEqual([
			{ recordId: "e1", label: "GitHub", service: "github.com" },
		]);
	});

	it("sends the seed inside the encrypted bundle, never as identity metadata", async () => {
		meta.set(PREF_AUTOFILL_QUICKTYPE, true);
		await mobileAutofill.setIndex([login({ totp: "GEZDGNBVGY3TQOJQ" })]);
		const sent = lastSync();
		expect(sent.ciphertext).toContain("GEZDGNBVGY3TQOJQ");
		expect(JSON.stringify(sent.oneTimeCodeIdentities)).not.toContain("GEZDGNBVGY3TQOJQ");
	});
});
