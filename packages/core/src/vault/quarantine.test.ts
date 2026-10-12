import { describe, expect, it } from "vitest";
import type { EntriesPayload } from "../sync/entries-payload";
import type { Hlc } from "../sync/hlc";
import type { EncryptedEntry } from "../vault-format";
import type { EntriesBlobStore } from "./entries-blob";
import { type QuarantinedEntry, quarantineEntries } from "./quarantine";

const hlc = (wall: number, node = "n"): Hlc => ({ wall, counter: 0, node });
const env = (id: string, wall = 1): EncryptedEntry => ({
	id,
	wrappedDek: "w",
	dekIv: "d",
	ciphertext: id,
	iv: "i",
	hlc: hlc(wall),
});

function fakes(initial: EntriesPayload) {
	let quarantine: string | null = null;
	let disk = initial;
	const storage = {
		readQuarantine: async () => quarantine,
		writeQuarantine: async (json: string) => {
			quarantine = json;
		},
	};
	const store: EntriesBlobStore = {
		readEntriesPayload: async () => disk,
		writeEntriesBlob: async (p) => {
			disk = p;
		},
	};
	return {
		storage,
		store,
		disk: () => disk,
		setDisk: (p: EntriesPayload) => {
			disk = p;
		},
		kept: () => (quarantine === null ? [] : (JSON.parse(quarantine) as QuarantinedEntry[])),
		setRaw: (raw: string) => {
			quarantine = raw;
		},
	};
}

describe("quarantineEntries", () => {
	it("moves unreadable entries out of the vault and keeps them sealed", async () => {
		const f = fakes({ entries: [env("mine"), env("stray")], tombstones: [] });
		await quarantineEntries({ storage: f.storage, store: f.store, vaultId: "v", now: 1000 }, [
			env("stray"),
		]);
		expect(f.disk().entries.map((e) => e.id)).toEqual(["mine"]);
		expect(f.kept()).toEqual([{ ...env("stray"), quarantinedAt: 1000 }]);
	});

	it("can empty a vault that held only stray entries", async () => {
		const f = fakes({ entries: [env("stray")], tombstones: [] });
		await quarantineEntries({ storage: f.storage, store: f.store, vaultId: "v", now: 1 }, [
			env("stray"),
		]);
		expect(f.disk().entries).toEqual([]);
		expect(f.kept()).toHaveLength(1);
	});

	it("keeps entries a merge added since the load", async () => {
		const f = fakes({ entries: [env("mine"), env("stray")], tombstones: [] });
		f.setDisk({ entries: [env("mine"), env("stray"), env("fromPeer")], tombstones: [] });
		await quarantineEntries({ storage: f.storage, store: f.store, vaultId: "v", now: 1 }, [
			env("stray"),
		]);
		expect(f.disk().entries.map((e) => e.id)).toEqual(["mine", "fromPeer"]);
	});

	it("only removes the exact version it found unreadable", async () => {
		const f = fakes({ entries: [env("x", 2)], tombstones: [] });
		await quarantineEntries({ storage: f.storage, store: f.store, vaultId: "v", now: 1 }, [
			env("x", 1),
		]);
		expect(f.disk().entries.map((e) => e.id)).toEqual(["x"]);
	});

	it("does not store the same version twice, and never drops what it kept", async () => {
		const f = fakes({ entries: [env("a"), env("b")], tombstones: [] });
		const deps = { storage: f.storage, store: f.store, vaultId: "v", now: 1 };
		await quarantineEntries(deps, [env("a")]);
		await quarantineEntries(deps, [env("a"), env("b")]);
		expect(f.kept().map((q) => q.id)).toEqual(["a", "b"]);
	});

	it("stores before rewriting, so a failed rewrite loses nothing", async () => {
		const f = fakes({ entries: [env("stray")], tombstones: [] });
		const store: EntriesBlobStore = {
			...f.store,
			writeEntriesBlob: async () => {
				throw new Error("disk full");
			},
		};
		await expect(
			quarantineEntries({ storage: f.storage, store, vaultId: "v", now: 1 }, [env("stray")]),
		).rejects.toThrow();
		expect(f.kept()).toHaveLength(1);
	});

	it.each(["{not json", '{"an":"object"}'])(
		"keeps a store it can't read (%s) inside the new one, and still opens",
		async (raw) => {
			const f = fakes({ entries: [env("stray")], tombstones: [] });
			f.setRaw(raw);
			await quarantineEntries({ storage: f.storage, store: f.store, vaultId: "v", now: 5 }, [
				env("stray"),
			]);
			expect(f.disk().entries).toEqual([]);
			expect(f.kept()).toEqual([
				{ unreadableStore: raw, quarantinedAt: 5 },
				{ ...env("stray"), quarantinedAt: 5 },
			]);
		},
	);

	it("carries records it doesn't recognise forward untouched", async () => {
		const f = fakes({ entries: [env("stray")], tombstones: [] });
		f.setRaw('[1,"x",null]');
		await quarantineEntries({ storage: f.storage, store: f.store, vaultId: "v", now: 5 }, [
			env("stray"),
		]);
		expect(f.disk().entries).toEqual([]);
		expect(f.kept()).toEqual([1, "x", null, { ...env("stray"), quarantinedAt: 5 }]);
	});
});
