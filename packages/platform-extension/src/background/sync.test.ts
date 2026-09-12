import {
	addVault,
	EMPTY_REGISTRY,
	VAULT_REGISTRY_KEY,
	type VaultRegistry,
} from "@core/vault/vault-registry";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACTIVE_VAULT_SESSION_KEY } from "../session-keys";
import { memoryStorageArea } from "../test/test-harness";

// Capture what the background hands the offscreen host. The rest of the background wiring is
// stubbed so importing ./sync doesn't drag in the router/offscreen machinery.
const { sendToOffscreen } = vi.hoisted(() => ({
	// Typed with the message param so `.mock.calls[i][0]` is the sent message, not an empty tuple.
	sendToOffscreen: vi.fn((_message: { type?: string; payload?: Record<string, unknown> }) =>
		Promise.resolve({ ok: true }),
	),
}));
vi.mock("./offscreen-client", () => ({
	sendToOffscreen,
	setInProcessSyncBridge: vi.fn(),
	useOffscreenDoc: false,
	ensureOffscreen: vi.fn(async () => {}),
	markOffscreenKey: vi.fn(),
}));
vi.mock("./router", () => ({
	on: vi.fn(),
	onPrefix: vi.fn(),
	extensionOnly: (fn: unknown) => fn,
	setReady: vi.fn(),
}));
vi.mock("../offscreen-core", () => ({ setSyncBridge: vi.fn() }));
vi.mock("./sync-clock", () => ({ witnessStamp: vi.fn(async () => {}), witnessStamps: vi.fn() }));

// chrome stub with local + session storage, alarms, and runtime (./sync adds a status listener at
// import). No `offscreen` key -> the code treats the host as suspend-y and arms the keepalive alarm.
//
// `runtime` also has to carry getURL, id and onConnect: ./sync imports ./desktop-link, which
// registers a port listener at import and resolves the extension origin through ../sender. An
// https stand-in for getURL, because Node gives chrome-extension:// an opaque origin.
function stubChrome(
	localSeed: Record<string, unknown> = {},
	sessionSeed: Record<string, unknown> = {},
) {
	const local = { ...localSeed };
	const session = { ...sessionSeed };
	vi.stubGlobal("chrome", {
		storage: { local: memoryStorageArea(local), session: memoryStorageArea(session) },
		alarms: { create: vi.fn(), clear: vi.fn(async () => {}) },
		runtime: {
			onMessage: { addListener: vi.fn() },
			onConnect: { addListener: vi.fn() },
			id: "bramble-test",
			getURL: (p: string) => `https://bramble-test.example/${p}`,
		},
	});
}

async function loadSync() {
	vi.resetModules();
	return import("./sync");
}

const roster = (label: string) => ({
	devices: [
		{ id: label, publicKey: label, label, addedAt: 0, hlc: { wall: 0, counter: 0, node: label } },
	],
	revoked: [],
});
const two: VaultRegistry = addVault(
	addVault(EMPTY_REGISTRY, { id: "a", label: "", createdAt: 1 }),
	{
		id: "b",
		label: "",
		createdAt: 2,
	},
);

afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

describe("maybeStartSync (per-vault)", () => {
	it("syncs the active vault's group, not the primary's", async () => {
		// Primary "a" (flat keys) and active "b" (namespaced) each have their own group + keypair.
		stubChrome(
			{
				[VAULT_REGISTRY_KEY]: two,
				"sync.group": { groupKey: "GROUP_A", roster: roster("a") },
				"sync.deviceKeypair": { privateKey: "apriv", publicKey: "apub" },
				"sync.group:b": { groupKey: "GROUP_B", roster: roster("b") },
				"sync.deviceKeypair:b": { privateKey: "bpriv", publicKey: "bpub" },
			},
			{ [ACTIVE_VAULT_SESSION_KEY]: "b" },
		);
		const { maybeStartSync } = await loadSync();
		await maybeStartSync();

		const rosterSync = sendToOffscreen.mock.calls
			.map((c) => c[0])
			.find((m) => m.type === "SYNC_ROSTER_SYNC");
		expect(rosterSync).toBeDefined();
		expect(rosterSync?.payload?.groupKeyB64).toBe("GROUP_B");
		expect(rosterSync?.payload?.devicePrivB64).toBe("bpriv");
		expect(rosterSync?.payload?.devicePubB64).toBe("bpub");
	});

	it("does not start sync when the active vault has no group (even if the primary does)", async () => {
		stubChrome(
			{
				[VAULT_REGISTRY_KEY]: two,
				"sync.group": { groupKey: "GROUP_A", roster: roster("a") },
				"sync.deviceKeypair": { privateKey: "apriv", publicKey: "apub" },
			},
			{ [ACTIVE_VAULT_SESSION_KEY]: "b" },
		);
		const { maybeStartSync } = await loadSync();
		await maybeStartSync();

		const started = sendToOffscreen.mock.calls.some((c) => c[0].type === "SYNC_ROSTER_SYNC");
		expect(started).toBe(false);
	});

	it("does not resume a held sync start after stopSync wins", async () => {
		stubChrome(
			{
				[VAULT_REGISTRY_KEY]: two,
				"sync.group:b": { groupKey: "GROUP_B", roster: roster("b") },
				"sync.deviceKeypair:b": { privateKey: "bpriv", publicKey: "bpub" },
			},
			{ [ACTIVE_VAULT_SESSION_KEY]: "b" },
		);
		const chrome = globalThis.chrome as any;
		const originalGet = chrome.storage.local.get;
		let releaseGroup: ((value: unknown) => void) | undefined;
		chrome.storage.local.get = vi.fn((key: string) => {
			if (key === "sync.group:b") {
				return new Promise((resolve) => {
					releaseGroup = resolve;
				});
			}
			return originalGet(key);
		});
		const { maybeStartSync, stopSync } = await loadSync();
		const starting = maybeStartSync();
		await vi.waitFor(() => expect(releaseGroup).toBeTypeOf("function"));
		await stopSync();
		releaseGroup?.({ "sync.group:b": { groupKey: "GROUP_B", roster: roster("b") } });
		await starting;
		expect(sendToOffscreen.mock.calls.some((c) => c[0].type === "SYNC_ROSTER_SYNC")).toBe(false);
	});
});
