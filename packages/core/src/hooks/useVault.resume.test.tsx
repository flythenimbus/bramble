/** @vitest-environment happy-dom */
// Every mutation rewrites the whole vault from what the provider holds in memory. So nothing may
// write until that memory holds the open vault: a view reopened on an unlocked vault once published
// the vault's name over an empty snapshot, and the vault's entries were gone from disk.
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useVaultNameSync, VAULT_NAME_KEY } from "../app/hooks/useVaultName";
import { type Platform, PlatformProvider } from "../context/PlatformContext";
import type { EntriesPayload } from "../sync";
import { fileRecord } from "../test/vault-fixtures";
import type { CopiedOut } from "../vault/combine-into";
import { VAULT_REGISTRY_KEY } from "../vault/vault-registry";
import { type SyncedSettingsAccess, useSyncedSettings } from "./synced-settings";
import { useVault, useVaultActions, VaultProvider } from "./useVault";
import { useVaultRegistry, VaultRegistryProvider } from "./useVaultRegistry";

i18n.load("en", {});
i18n.activate("en");
afterEach(cleanup);

vi.mock("../vault-format", async (importOriginal) => ({
	...(await importOriginal<typeof import("../vault-format")>()),
	decodeVaultBlob: () => ({
		slots: [
			{
				kind: 0x01,
				slotId: new Uint8Array(16),
				salt: new Uint8Array(16),
				verifier: new Uint8Array(32),
				wrapIv: new Uint8Array(12),
				wrappedVek: new Uint8Array(32),
			},
		],
		entriesIv: new Uint8Array(12),
		entriesCiphertext: new Uint8Array([1]),
	}),
	encodeVaultBlob: () => new Uint8Array([1, 2, 3]),
}));

// Past a merge in flight, in real use. No merge runs in these tests.
vi.mock("../vault/combine-into", async (importOriginal) => ({
	...(await importOriginal<typeof import("../vault/combine-into")>()),
	MERGE_SETTLE_MS: 5,
}));

const at = (wall: number, node: string) => ({ wall, counter: 0, node });
const LOGIN = JSON.stringify({
	type: "login",
	name: "Keep me",
	urls: [],
	username: "u",
	password: "p",
});
const entry = (id: string) => ({
	id,
	wrappedDek: "w",
	dekIv: "d",
	iv: "i",
	ciphertext: `ct:${LOGIN}`,
	hlc: at(20, "laptop"),
	vv: { laptop: at(20, "laptop") },
});
const NAMED = { [VAULT_NAME_KEY]: { hlc: at(5, "laptop"), value: "Personal" } };

function makePlatform(
	disks: Record<string, EntriesPayload>,
	vaults: { id: string; label: string; createdAt: number }[],
	opts: { locked?: () => boolean } = {},
) {
	const meta = new Map<string, unknown>([[VAULT_REGISTRY_KEY, { vaults }]]);
	/** Every payload written to disk, oldest first. */
	const writes: EntriesPayload[] = [];
	const erased: string[] = [];
	let release: (() => void) | null = null;
	let gate: Promise<void> | null = new Promise<void>((r) => {
		release = r;
	});
	/** Which vault each write went to, in the order of `writes`. */
	const writtenTo: string[] = [];
	const locked: string[] = [];
	const onDisk = new Map(Object.entries(disks));
	const firstVault = Object.keys(disks)[0] as string;
	const failing = { registryWrites: false };
	let onExternalLock: (() => void) | null = null;
	const crypto = {
		isLocked: async () => opts.locked?.() ?? false,
		onExternalLock: (cb: () => void) => {
			onExternalLock = cb;
			return () => {};
		},
		onExternalChange: () => () => {},
		unwrapVekPassword: async () => true,
		encryptEntry: async (json: string) => ({
			ciphertext: `ct:${json}`,
			iv: "i",
			wrappedDek: "w",
			dekIv: "d",
		}),
		// Held open, so a test can look at everything that happens while the vault is still loading.
		decryptEntries: async (ps: { ciphertext: string }[]) => {
			if (gate) await gate;
			return ps.map((p) => (p.ciphertext.startsWith("ct:") ? p.ciphertext.slice(3) : null));
		},
	};
	/** Each vault's disk through its own key, as the real adapters scope it. */
	const scoped = (id: string) => ({
		...crypto,
		withVault: scoped,
		decryptWithVek: async () => JSON.stringify(onDisk.get(id) ?? { entries: [], tombstones: [] }),
		encryptWithVek: async (plaintext: string) => {
			const payload = JSON.parse(plaintext) as EntriesPayload;
			writes.push(payload);
			writtenTo.push(id);
			onDisk.set(id, payload);
			return { iv: "AAAAAAAAAAAAAAAA", ciphertext: "AA==" };
		},
		lock: async () => void locked.push(id),
	});
	const platform = {
		target: "chromium",
		storage: {
			getMeta: async (k: string) => meta.get(k),
			setMeta: async (k: string, v: unknown) => {
				if (failing.registryWrites && k === VAULT_REGISTRY_KEY) throw new Error("storage full");
				meta.set(k, v);
			},
			removeMeta: async (k: string) => void meta.delete(k),
			hasVaultHandle: async () => true,
			readVaultBlob: async () => new Uint8Array([1]),
			writeVaultBlob: async () => {},
			deleteVaultBlob: async (id: string) => void erased.push(id),
			restoreVaultFromBackup: async () => false,
			readQuarantine: async () => null,
			writeQuarantine: async () => {},
		},
		crypto: scoped(firstVault),
		autofill: { clearIndex: async () => {}, setIndex: async () => {} },
		shell: {
			setActiveVault: async () => {},
			onSyncStatus: () => () => {},
			onSyncEvent: () => () => {},
			flushPendingCornerCapture: async () => false,
		},
		clipboard: {},
	} as unknown as Platform;
	return {
		platform,
		writes,
		writtenTo,
		erased,
		locked,
		failing,
		/** Let the load that is holding at decrypt finish. */
		finishLoad: () => {
			gate = null;
			release?.();
		},
		/** Hold the next load at decrypt. */
		holdLoad: () => {
			gate = new Promise<void>((r) => {
				release = r;
			});
		},
		/** A background lock (auto-lock alarm), as the provider hears of it. */
		lockFromOutside: () => onExternalLock?.(),
		setDisk: (p: EntriesPayload, id = firstVault) => {
			onDisk.set(id, p);
		},
	};
}

/** The provider stack, with name sync mounted as AppLayout mounts it, under `/vault`. */
function mount(platform: Platform) {
	const seen = {
		state: null as ReturnType<typeof useVault> | null,
		actions: null as ReturnType<typeof useVaultActions> | null,
		synced: null as SyncedSettingsAccess | null,
		registry: null as ReturnType<typeof useVaultRegistry> | null,
	};
	function Consumer() {
		seen.state = useVault();
		seen.actions = useVaultActions();
		seen.synced = useSyncedSettings();
		seen.registry = useVaultRegistry();
		useVaultNameSync();
		return null;
	}
	render(
		<I18nProvider i18n={i18n}>
			<PlatformProvider platform={platform}>
				<VaultRegistryProvider>
					<VaultProvider>
						<Consumer />
					</VaultProvider>
				</VaultRegistryProvider>
			</PlatformProvider>
		</I18nProvider>,
	);
	return seen;
}

const settle = () => act(() => new Promise<void>((r) => setTimeout(r, 30)));

describe("a view reopened on an unlocked vault", () => {
	it("stays locked, and writes nothing, until the vault's entries are in", async () => {
		const p = makePlatform({ v1: { entries: [entry("a")], tombstones: [], settings: NAMED } }, [
			{ id: "v1", label: "Personal", createdAt: 1 },
		]);
		const seen = mount(p.platform);
		await settle();

		expect(seen.state?.isLocked).toBe(true);
		expect(seen.synced?.ready).toBe(false);
		expect(p.writes).toEqual([]);

		p.finishLoad();
		await waitFor(() => expect(seen.state?.isLocked).toBe(false));
		expect(seen.state?.entries).toHaveLength(1);
		expect(seen.synced?.ready).toBe(true);
		await settle();
		// Its name is in its settings already: nothing to publish, and nothing written.
		expect(p.writes).toEqual([]);
	});

	it("publishes a name the vault has not synced yet over its entries, not over nothing", async () => {
		const p = makePlatform({ v1: { entries: [entry("a")], tombstones: [] } }, [
			{ id: "v1", label: "Personal", createdAt: 1 },
		]);
		const seen = mount(p.platform);
		await settle();
		expect(p.writes).toEqual([]);

		p.finishLoad();
		await waitFor(() => expect(p.writes).toHaveLength(1));
		expect(p.writes[0]?.entries.map((e) => e.id)).toEqual(["a"]);
		expect(p.writes[0]?.settings?.[VAULT_NAME_KEY]?.value).toBe("Personal");
		expect(seen.state?.entries).toHaveLength(1);
	});

	it("refuses a mutation made before the entries are in, rather than write an empty vault", async () => {
		const p = makePlatform({ v1: { entries: [entry("a")], tombstones: [] } }, [
			{ id: "v1", label: "", createdAt: 1 },
		]);
		const seen = mount(p.platform);
		await settle();

		await expect(
			seen.actions?.addEntry({
				type: "login",
				name: "Too soon",
				urls: [],
				username: "",
				password: "",
			}),
		).rejects.toThrow();
		expect(p.writes).toEqual([]);
		p.finishLoad();
		await waitFor(() => expect(seen.state?.isLocked).toBe(false));
	});

	it("stays locked when a lock lands while the entries were loading", async () => {
		let locked = false;
		const p = makePlatform(
			{ v1: { entries: [entry("a")], tombstones: [] } },
			[{ id: "v1", label: "", createdAt: 1 }],
			{ locked: () => locked },
		);
		const seen = mount(p.platform);
		await settle();

		locked = true;
		p.lockFromOutside();
		p.finishLoad();
		await settle();

		expect(seen.state?.isLocked).toBe(true);
		// Nothing decrypted stays behind on a screen that says locked.
		expect(seen.state?.entries).toEqual([]);
	});
});

describe("removing a vault whose entries were copied out", () => {
	function vaults() {
		const p = makePlatform({ v1: { entries: [entry("a")], tombstones: [] } }, [
			{ id: "v1", label: "", createdAt: 1 },
			{ id: "old", label: "", createdAt: 2 },
		]);
		return p;
	}

	async function open(p: ReturnType<typeof vaults>) {
		const seen = mount(p.platform);
		await settle();
		await act(async () => seen.registry?.selectVault("v1"));
		p.finishLoad();
		await waitFor(() => expect(seen.state?.entries).toHaveLength(1));
		return seen;
	}

	const copied = (over: Partial<CopiedOut> = {}): CopiedOut => ({
		blob: new Uint8Array([1]),
		items: [JSON.parse(LOGIN)],
		fileHashes: [],
		...over,
	});
	const remove = async (seen: Awaited<ReturnType<typeof open>>, id: string, proof = copied()) => {
		let removed: boolean | undefined;
		await act(async () => {
			removed = await seen.actions?.deleteCarriedVault(id, proof);
		});
		return removed;
	};

	it("erases it, its record and its key when all of the copy is on disk", async () => {
		const p = vaults();
		const seen = await open(p);

		expect(await remove(seen, "old")).toBe(true);

		expect(p.erased).toEqual(["old"]);
		expect(seen.registry?.vaults.map((v) => v.id)).toEqual(["v1"]);
		expect(p.locked).toEqual(["old"]);
	});

	it("refuses when an item is not on disk, though as many entries are as memory holds", async () => {
		// A merge overwrote the import, and memory was reloaded from what it left.
		const p = vaults();
		const seen = await open(p);
		const other = LOGIN.replace("Keep me", "Something else");
		p.setDisk({ entries: [{ ...entry("z"), ciphertext: `ct:${other}` }], tombstones: [] });

		expect(await remove(seen, "old")).toBe(false);
		expect(p.erased).toEqual([]);
		expect(seen.registry?.vaults.map((v) => v.id)).toEqual(["v1", "old"]);
	});

	it("refuses when what was folded into an entry is not on disk", async () => {
		const p = vaults();
		const seen = await open(p);
		const items = [{ ...JSON.parse(LOGIN), tags: ["work"] }];

		expect(await remove(seen, "old", copied({ items }))).toBe(false);
		expect(p.erased).toEqual([]);
	});

	it("refuses when the old vault changed after the copy began", async () => {
		// A login saved from the page into the old vault: it is in no copy.
		const p = vaults();
		const seen = await open(p);

		expect(await remove(seen, "old", copied({ blob: new Uint8Array([9]) }))).toBe(false);
		expect(p.erased).toEqual([]);
	});

	it("refuses when a file the copy stored is not on disk", async () => {
		const p = vaults();
		const seen = await open(p);
		const held = fileRecord({ id: "f1" });
		p.setDisk({ entries: [entry("a")], tombstones: [], files: [held] });

		expect(await remove(seen, "old", copied({ fileHashes: [held.hash, "f".repeat(64)] }))).toBe(
			false,
		);
		expect(p.erased).toEqual([]);

		expect(await remove(seen, "old", copied({ fileHashes: [held.hash] }))).toBe(true);
	});

	it("reads the disk only after a merge in flight has had time to land", async () => {
		const p = vaults();
		const seen = await open(p);
		let removed: boolean | undefined;

		await act(async () => {
			const removing = seen.actions?.deleteCarriedVault("old", copied());
			p.setDisk({ entries: [], tombstones: [] });
			removed = await removing;
		});

		expect(removed).toBe(false);
		expect(p.erased).toEqual([]);
	});

	it("leaves it whole when its record cannot be removed", async () => {
		const p = vaults();
		const seen = await open(p);
		p.failing.registryWrites = true;

		await act(async () => {
			await expect(seen.actions?.deleteCarriedVault("old", copied())).rejects.toThrow();
		});

		expect(p.erased).toEqual([]);
		expect(p.locked).toEqual([]);
	});

	it("refuses the vault that is open", async () => {
		const p = vaults();
		const seen = await open(p);

		expect(await remove(seen, "v1")).toBe(false);
		expect(p.erased).toEqual([]);
	});
});

describe("importing into the open vault", () => {
	const moved = {
		type: "login",
		name: "Moved",
		urls: [],
		username: "u",
		password: "p",
		passwordChangelog: [{ value: "older", changedAt: 1 }],
	} as never;
	const written = (p: ReturnType<typeof makePlatform>) =>
		JSON.parse(p.writes.at(-1)?.entries.at(-1)?.ciphertext.slice(3) ?? "{}").passwordChangelog;

	async function open() {
		const p = makePlatform({ v1: { entries: [], tombstones: [] } }, [
			{ id: "v1", label: "", createdAt: 1 },
		]);
		const seen = mount(p.platform);
		p.finishLoad();
		await waitFor(() => expect(seen.state?.isLocked).toBe(false));
		return { p, seen };
	}

	it("writes the old passwords of an entry from the user's own vault", async () => {
		const { p, seen } = await open();
		await act(async () => seen.actions?.importEntries([moved], [], { ownVault: true }));
		expect(written(p)).toEqual([{ value: "older", changedAt: 1 }]);
	});

	it("writes none from anywhere else", async () => {
		const { p, seen } = await open();
		await act(async () => seen.actions?.importEntries([moved]));
		expect(written(p)).toBeUndefined();
	});
});

describe("the open vault changing under an unlocked view", () => {
	it("holds its settings as not ready until the new vault has loaded", async () => {
		// Linking from Settings: the join opens another vault with this screen still up. Until it has
		// loaded, the memory and settings in hand are still the old vault's.
		const p = makePlatform(
			{
				v1: { entries: [entry("a")], tombstones: [], settings: NAMED },
				v2: { entries: [entry("b")], tombstones: [] },
			},
			[
				{ id: "v1", label: "Personal", createdAt: 1 },
				{ id: "v2", label: "", createdAt: 2 },
			],
		);
		const seen = mount(p.platform);
		await settle();
		await act(async () => seen.registry?.selectVault("v1"));
		p.finishLoad();
		await waitFor(() => expect(seen.synced?.ready).toBe(true));

		p.holdLoad();
		await act(async () => seen.registry?.selectVault("v2"));
		await settle();

		expect(seen.synced?.ready).toBe(false);
		await expect(
			seen.actions?.addEntry({
				type: "login",
				name: "Wrong vault",
				urls: [],
				username: "",
				password: "",
			}),
		).rejects.toThrow();
		expect(p.writes).toEqual([]);
		// The old vault's name was not put on the new one.
		expect(seen.registry?.vaults.find((v) => v.id === "v2")?.label).toBe("");

		// Once it has loaded, it writes as itself: over its own entries, to its own file.
		p.finishLoad();
		await waitFor(() => expect(seen.synced?.ready).toBe(true));
		await act(async () => {
			await seen.actions?.addEntry({
				type: "login",
				name: "Right vault",
				urls: [],
				username: "",
				password: "",
			});
		});
		expect(p.writtenTo.at(-1)).toBe("v2");
		expect(p.writes.at(-1)?.entries.map((e) => e.id)).toContain("b");
		expect(p.writes.at(-1)?.entries.map((e) => e.id)).not.toContain("a");
	});
});
