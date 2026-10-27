import { canonicalRosterEntry, type RosterEntry } from "@core/sync/roster";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The enroll host must add a freshly joined device to the local roster itself, admission-signing it
// where it can, rather than leaving that to the window that started the invite. Desktop is the
// worst case for leaning on the window: closing it does not end the process, so an invite can
// outlive the UI entirely, and a lost roster write leaves the joiner rejected as "not in roster"
// when it comes back for ongoing sync. That reads as a pairing that worked and then silently
// didn't. Mirrors the extension's offscreen-enroll-roster test, which guards the same fix on
// Firefox's event page.

const h = vi.hoisted(() => ({
	meta: new Map<string, unknown>(),
	/** The options the enroll host was started with, so a test can drive its callbacks. */
	enrollOpts: null as Record<string, (...a: never[]) => unknown> | null,
}));

vi.mock("@core/sync/transport/enroll-host", () => ({
	startEnroll: async (_role: string, opts: Record<string, (...a: never[]) => unknown>) => {
		h.enrollOpts = opts;
		return { stop: () => {} };
	},
}));

vi.mock("../adapters/storage", () => ({
	desktopStorage: {
		getMeta: async (k: string) => h.meta.get(k),
		setMeta: async (k: string, v: unknown) => {
			h.meta.set(k, v);
		},
		removeMeta: async (k: string) => {
			h.meta.delete(k);
		},
		readVaultBlob: async () => new Uint8Array([9]),
		writeVaultBlob: async () => {},
	},
}));

vi.mock("../adapters/crypto", () => ({
	desktopCrypto: {
		exportVek: async () => "VEK",
		encryptWithVek: async () => ({ iv: "AAAA", ciphertext: "BBBB" }),
		decryptWithVek: async () => JSON.stringify({ entries: [], tombstones: [] }),
	},
}));

vi.mock("../adapters/vault-session", () => ({
	notifyExternalChange: () => {},
	onVaultStateChange: () => () => {},
}));

// The two keypairs and the admission signer come from the OS credential store over Tauri IPC,
// which does not exist here. The signature is stubbed deterministically, as Ed25519 is.
vi.mock("./keys", () => ({
	deviceKeypair: async () => ({ privateKey: "p", publicKey: "P" }),
	syncAdmissionSign: async (_password: string, _saltB64: string, message: string) =>
		`sig(${message})`,
	clearSyncIdentity: async () => {},
}));
vi.mock("../sync-crypto", () => ({ desktopSyncCrypto: {} }));

const VAULT = "vault-a";

const JOINER: RosterEntry = {
	id: "joiner-id",
	publicKey: "joinerPub",
	label: "Joiner",
	addedAt: 0,
	hlc: { wall: 1000, counter: 0, node: "joiner-id" },
};

/** The roster this device already has: itself, and nothing else. */
const INVITER: RosterEntry = {
	id: "inviter-id",
	publicKey: "inviterPub",
	label: "Inviter",
	addedAt: 0,
	hlc: { wall: 500, counter: 0, node: "inviter-id" },
};

function storedRoster(vaultId = VAULT) {
	return (h.meta.get(`sync.group:${vaultId}`) as { roster: { devices: RosterEntry[] } }).roster;
}

function joiner(vaultId = VAULT) {
	return storedRoster(vaultId).devices.find((d) => d.publicKey === "joinerPub");
}

async function invite(mod: typeof import("./transport"), admission?: Record<string, string>) {
	await mod.startEnrollInvite({
		relayUrl: "wss://relay.invalid",
		groupKeyB64: "k",
		psk: "psk",
		roster: { devices: [INVITER], revoked: [] },
		entries: { entries: [], tombstones: [] },
		admission: admission as { password: string; saltB64: string; adminId: string } | undefined,
	});
	if (!h.enrollOpts) throw new Error("enroll host never started");
}

/**
 * Fire the host's "a device finished joining" callback and wait for it to finish.
 *
 * Waits on the announcement rather than on the roster write, because the write is the thing under
 * test: a malformed entry produces no write at all, and waiting on one would hang.
 */
async function enrolled(entryJson: string) {
	const { onSyncEvent } = await import("./bus");
	const announced = new Promise<void>((resolve) => {
		const unsub = onSyncEvent((e) => {
			if (e.kind !== "enrolled") return;
			unsub();
			resolve();
		});
	});
	(h.enrollOpts as unknown as { onEnrolled: (j: string) => void }).onEnrolled(entryJson);
	await announced;
}

async function loadTransport() {
	vi.resetModules();
	return import("./transport");
}

beforeEach(() => {
	h.meta.clear();
	h.enrollOpts = null;
	h.meta.set("active-vault", VAULT);
	h.meta.set(`sync.group:${VAULT}`, {
		groupKey: "k",
		roster: { devices: [INVITER], revoked: [] },
	});
	vi.stubGlobal("crypto", { randomUUID: () => "id", getRandomValues: (a: Uint8Array) => a });
});

describe("host-side roster add on enroll", () => {
	it("admission-signs the joiner and writes it into the vault's roster", async () => {
		const mod = await loadTransport();
		await invite(mod, { password: "hunter2", saltB64: "SALT", adminId: "inviter-id" });
		await enrolled(JSON.stringify(JOINER));

		// The admission this produces must be what a peer recomputes and verifies: the admitter's
		// id, and a signature over the joiner's canonical entry.
		expect(joiner()?.admission).toEqual({
			by: "inviter-id",
			sig: `sig(${canonicalRosterEntry(JOINER)})`,
		});
	});

	it("adds the joiner unsigned when this device can't admit (security-key inviter)", async () => {
		const mod = await loadTransport();
		await invite(mod);
		await enrolled(JSON.stringify(JOINER));

		expect(joiner()).toBeDefined();
		expect(joiner()?.admission).toBeUndefined();
	});

	it("keeps the devices already in the roster", async () => {
		const mod = await loadTransport();
		await invite(mod);
		await enrolled(JSON.stringify(JOINER));

		// A union, not a replacement: admitting a device must never evict one.
		expect(
			storedRoster()
				.devices.map((d) => d.id)
				.sort(),
		).toEqual(["inviter-id", "joiner-id"]);
	});

	it("writes the roster before announcing the enrollment", async () => {
		const mod = await loadTransport();
		const { onSyncEvent } = await import("./bus");
		await invite(mod);

		// The UI does this same write when it sees the event. Ordering the two means its read sees
		// this one rather than racing it.
		let rosterAtEvent: RosterEntry | undefined;
		const unsub = onSyncEvent((e) => {
			if (e.kind === "enrolled") rosterAtEvent = joiner();
		});
		await enrolled(JSON.stringify(JOINER));
		unsub();

		expect(rosterAtEvent).toBeDefined();
	});

	it("survives a malformed enrolled entry without losing the roster", async () => {
		const mod = await loadTransport();
		await invite(mod);
		await enrolled("definitely not json");

		expect(joiner()).toBeUndefined();
		expect(storedRoster().devices).toHaveLength(1);
	});

	it("writes to the vault the invite was started for, not whichever is active later", async () => {
		const mod = await loadTransport();
		await invite(mod, { password: "hunter2", saltB64: "SALT", adminId: "inviter-id" });

		// The user switched vaults while the code was on screen. The joiner was handed vault A's
		// VEK, so it belongs in vault A's roster; adding it to B would enrol it in a group whose
		// vault it cannot open.
		h.meta.set("active-vault", "vault-b");
		h.meta.set(`sync.group:vault-b`, { groupKey: "k2", roster: { devices: [], revoked: [] } });
		await enrolled(JSON.stringify(JOINER));

		expect(joiner(VAULT)).toBeDefined();
		expect(joiner("vault-b")).toBeUndefined();
	});
});
