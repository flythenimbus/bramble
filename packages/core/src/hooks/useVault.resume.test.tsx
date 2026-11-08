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
import { bytesToBase64 } from "../util/bytes";
import { VAULT_REGISTRY_KEY } from "../vault/vault-registry";
import { type SyncedSettingsAccess, useSyncedSettings } from "./synced-settings";
import { useVault, useVaultActions, VaultProvider } from "./useVault";
import { useVaultRegistry, VaultRegistryProvider } from "./useVaultRegistry";

i18n.load("en", {});
i18n.activate("en");
afterEach(cleanup);

/** What the disk's ciphertext reads as: another window's save moves it on. */
const diskVersion = vi.hoisted(() => ({ current: 1 }));

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
		entriesCiphertext: new Uint8Array([diskVersion.current]),
	}),
	encodeVaultBlob: () => new Uint8Array([1, 2, 3]),
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
	opts: { locked?: () => boolean; oneWindow?: boolean } = {},
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
	const heard = new Set<() => void>();
	/** Runs inside the next entry's encryption, which on the extension is a round trip. */
	const duringEncrypt: { run: (() => Promise<void>) | null } = { run: null };
	/** How long the autofill index takes, also a round trip there. */
	const indexDelay = { ms: 0 };
	const crypto = {
		isLocked: async () => opts.locked?.() ?? false,
		onExternalLock: (cb: () => void) => {
			onExternalLock = cb;
			return () => {};
		},
		onExternalChange: (cb: () => void) => {
			heard.add(cb);
			return () => heard.delete(cb);
		},
		unwrapVekPassword: async () => true,
		encryptEntry: async (json: string) => {
			const run = duringEncrypt.run;
			duringEncrypt.run = null;
			await run?.();
			return { ciphertext: `ct:${json}`, iv: "i", wrappedDek: "w", dekIv: "d" };
		},
		// Held open, so a test can look at everything that happens while the vault is still loading.
		decryptEntries: async (ps: { ciphertext: string }[]) => {
			if (gate) await gate;
			return ps.map((p) => (p.ciphertext.startsWith("ct:") ? p.ciphertext.slice(3) : null));
		},
	};
	let notified = 0;
	let payloadReads = 0;
	/** Each vault's disk through its own key, as the real adapters scope it. */
	const scoped = (id: string) => ({
		...crypto,
		withVault: scoped,
		...(opts.oneWindow
			? {}
			: {
					notifyExternalChange: () => {
						notified++;
					},
				}),
		decryptWithVek: async () => {
			payloadReads++;
			return JSON.stringify(onDisk.get(id) ?? { entries: [], tombstones: [] });
		},
		encryptWithVek: async (plaintext: string) => {
			const payload = JSON.parse(plaintext) as EntriesPayload;
			writes.push(payload);
			writtenTo.push(id);
			onDisk.set(id, payload);
			// As the disk's ciphertext will read back.
			return {
				iv: "AAAAAAAAAAAAAAAA",
				ciphertext: bytesToBase64(new Uint8Array([diskVersion.current])),
			};
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
		autofill: {
			clearIndex: async () => {},
			setIndex: async () => {
				if (indexDelay.ms) await new Promise((r) => setTimeout(r, indexDelay.ms));
			},
		},
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
		notified: () => notified,
		duringEncrypt,
		indexDelay,
		/** What a window does on hearing another window saved. */
		hear: () => {
			for (const cb of heard) cb();
		},
		payloadReads: () => payloadReads,
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

describe("the open vault's disk, and an empty vault beside it", () => {
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

	it("reads the open vault from its disk, not from what memory holds", async () => {
		const p = vaults();
		const seen = await open(p);
		const saved = { ...JSON.parse(LOGIN), name: "Saved elsewhere" };
		const held = fileRecord({ id: "f1" });
		p.setDisk({
			entries: [
				entry("a"),
				{ ...entry("b"), ciphertext: `ct:${JSON.stringify(saved)}` },
				{ ...entry("c"), ciphertext: "will not open" },
			],
			tombstones: [],
			files: [held],
		});
		const onDisk = await seen.actions?.readOpenVaultFromDisk();
		expect(onDisk?.entries.map((e) => e.id)).toEqual(["a", "b"]);
		expect(onDisk?.entries[1]?.name).toBe("Saved elsewhere");
		expect(onDisk?.files.map((f) => f.hash)).toEqual([held.hash]);
		expect(onDisk?.unreadable).toBe(1);
		expect(seen.state?.entries.map((e) => e.id)).toEqual(["a"]);
	});

	it("will not delete an empty vault whose bytes changed after they were read", async () => {
		const p = vaults();
		const seen = await open(p);
		let removed: boolean | undefined;
		await act(async () => {
			removed = await seen.actions?.deleteEmptyVault("old", 0, 0, new Uint8Array([9]));
		});
		expect(removed).toBe(false);
		expect(p.erased).toEqual([]);
	});

	it("reads and writes a setting of the open vault through the one writer, onto its own disk", async () => {
		const p = vaults();
		const seen = await open(p);
		const value = { provider: "addy", options: {}, apiKey: "k" };
		expect(seen.actions?.readSetting("pref.aliasProvider")).toBeUndefined();

		await act(async () => {
			await seen.actions?.writeSetting("pref.aliasProvider", value);
		});

		expect(seen.actions?.readSetting("pref.aliasProvider")).toEqual(value);
		expect(p.writtenTo.at(-1)).toBe("v1");
		expect(p.writes.at(-1)?.settings?.["pref.aliasProvider"]?.value).toEqual(value);
		// Beside what it already held, as any other write.
		expect(p.writes.at(-1)?.entries.map((e) => e.id)).toContain("a");
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
	it("refuses to read or write a setting until the new vault has loaded", async () => {
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
		expect(() => seen.actions?.readSetting("pref.vaultName")).toThrow(/not finished loading/);
		await expect(seen.actions?.writeSetting("pref.vaultName", "x")).rejects.toThrow(
			/not finished loading/,
		);
		expect(p.writtenTo).toEqual([]);
	});

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

describe("another window saving under an open one", () => {
	const seenLogin = (name: string) => JSON.stringify({ ...JSON.parse(LOGIN), name });
	const otherWindowSaves = (p: ReturnType<typeof makePlatform>, payload: EntriesPayload) => {
		p.setDisk(payload);
		diskVersion.current++;
	};
	async function openOne() {
		diskVersion.current = 1;
		const p = makePlatform({ v1: { entries: [entry("a")], tombstones: [] } }, [
			{ id: "v1", label: "", createdAt: 1 },
		]);
		const seen = mount(p.platform);
		await settle();
		await act(async () => seen.registry?.selectVault("v1"));
		p.finishLoad();
		await waitFor(() => expect(seen.synced?.ready).toBe(true));
		return { p, seen };
	}
	const newLogin = {
		type: "login" as const,
		name: "Saved here",
		urls: [],
		username: "",
		password: "",
	};

	it("keeps what it saved, and shows it here once the disk has been read again", async () => {
		const { p, seen } = await openOne();
		otherWindowSaves(p, {
			entries: [entry("a"), { ...entry("b"), ciphertext: `ct:${seenLogin("Saved elsewhere")}` }],
			tombstones: [],
		});

		await act(async () => {
			await seen.actions?.addEntry(newLogin);
		});

		expect(p.writes.at(-1)?.entries.map((e) => e.id)).toContain("b");
		expect(p.writes.at(-1)?.entries).toHaveLength(3);
		await waitFor(() =>
			expect(seen.state?.entries.map((e) => e.name)).toContain("Saved elsewhere"),
		);
		expect(seen.state?.entries.map((e) => e.name)).toContain("Saved here");
	});

	it("does not bring back what it deleted", async () => {
		const { p, seen } = await openOne();
		otherWindowSaves(p, {
			entries: [],
			tombstones: [{ id: "a", hlc: at(9_000_000_000_000, "other") }],
		});
		await act(async () => {
			await seen.actions?.addEntry(newLogin);
		});
		expect(p.writes.at(-1)?.entries.map((e) => e.id)).not.toContain("a");
		await waitFor(() => expect(seen.state?.entries.map((e) => e.id)).not.toContain("a"));
	});

	it("doesn't take a reload during its own write for having caught up", async () => {
		// The snapshot is taken, the other window saves, this window hears and reloads, and only then
		// does this write reach the disk, still holding the old snapshot. An attachment's seal makes
		// that gap as long as the file takes.
		const { p, seen } = await openOne();
		p.duringEncrypt.run = async () => {
			otherWindowSaves(p, {
				entries: [entry("a"), { ...entry("b"), ciphertext: `ct:${seenLogin("Saved elsewhere")}` }],
				tombstones: [],
			});
			p.hear();
			await new Promise((r) => setTimeout(r, 20));
		};
		await act(async () => {
			await seen.actions?.addEntry(newLogin);
		});
		expect(p.writes.at(-1)?.entries.map((e) => e.id)).toContain("b");
		expect(p.writes.at(-1)?.entries).toHaveLength(3);
	});

	it("doesn't let the reload after a merge land before the merge is committed", async () => {
		// The index is a round trip the reload can beat. Committing what this window knew after that
		// would leave memory short of what it merged with, and the next save would write over it.
		const { p, seen } = await openOne();
		p.indexDelay.ms = 40;
		otherWindowSaves(p, {
			entries: [entry("a"), { ...entry("b"), ciphertext: `ct:${seenLogin("Saved elsewhere")}` }],
			tombstones: [],
		});
		await act(async () => {
			await seen.actions?.addEntry(newLogin);
		});
		p.indexDelay.ms = 0;
		await waitFor(() =>
			expect(seen.state?.entries.map((e) => e.name)).toContain("Saved elsewhere"),
		);
		await act(async () => {
			await seen.actions?.addEntry({ ...newLogin, name: "Saved here too" });
		});
		const written = p.writes.at(-1)?.entries.map((e) => e.id);
		expect(written).toContain("b");
		expect(written).toHaveLength(4);
	});

	it("reads nothing extra, and merges with nothing, where there is only ever one window", async () => {
		diskVersion.current = 1;
		const p = makePlatform(
			{ v1: { entries: [entry("a")], tombstones: [] } },
			[{ id: "v1", label: "", createdAt: 1 }],
			{ oneWindow: true },
		);
		const seen = mount(p.platform);
		await settle();
		await act(async () => seen.registry?.selectVault("v1"));
		p.finishLoad();
		await waitFor(() => expect(seen.synced?.ready).toBe(true));
		// A background sync write, say, which that platform's own reload picks up.
		diskVersion.current++;
		const reads = p.payloadReads();
		await act(async () => {
			await seen.actions?.addEntry(newLogin);
		});
		expect(p.payloadReads()).toBe(reads);
	});

	it("drops a reload under way when the vault locks, leaving nothing decrypted", async () => {
		const { p, seen } = await openOne();
		p.holdLoad();
		act(() => p.hear());
		await act(async () => p.lockFromOutside());
		p.finishLoad();
		await settle();
		expect(seen.state?.isLocked).toBe(true);
		expect(seen.state?.entries).toEqual([]);
		expect(seen.synced?.settings).toBeUndefined();
	});

	it("writes as before with nothing else having written, and reads nothing back", async () => {
		const { p, seen } = await openOne();
		const before = seen.state?.entries.length ?? 0;
		const reads = p.payloadReads();
		await act(async () => {
			await seen.actions?.addEntry(newLogin);
		});
		expect(p.writes.at(-1)?.entries).toHaveLength(before + 1);
		// The same again: its own write is what the disk holds now.
		await act(async () => {
			await seen.actions?.addEntry({ ...newLogin, name: "Saved here too" });
		});
		expect(p.writes.at(-1)?.entries).toHaveLength(before + 2);
		expect(p.payloadReads()).toBe(reads);
		await act(async () => {
			await new Promise((r) => setTimeout(r, 20));
		});
		expect(seen.state?.entries).toHaveLength(before + 2);
		expect(p.payloadReads()).toBe(reads);
	});

	it("tells other windows it saved", async () => {
		const { p, seen } = await openOne();
		const before = p.notified();
		await act(async () => {
			await seen.actions?.addEntry(newLogin);
		});
		expect(p.notified()).toBe(before + 1);
	});
});
