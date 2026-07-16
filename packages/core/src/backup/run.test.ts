import { describe, expect, it } from "vitest";
import type { BackupFrequency, BackupTargetConfig } from "./config";
import { runScheduledBackups, type ScheduledBackupDeps, type VaultBackup } from "./run";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

function target(
	id: string,
	frequency: BackupFrequency,
	extra: Partial<BackupTargetConfig> = {},
): BackupTargetConfig {
	return {
		id,
		providerId: "s3",
		provider: "s3",
		frequency,
		keep: 30,
		creds: { iv: id, ciphertext: "x" }, // iv == id, so fakes can key off it
		...extra,
	};
}

// In-memory fakes. `uploadFail`/`decryptFail` are keyed by target id.
const ONE_VAULT: VaultBackup[] = [{ id: "v1", blob: new Uint8Array([1, 2, 3]), legacy: true }];

function harness(
	initial: BackupTargetConfig[],
	opts: {
		hash?: string;
		vaults?: VaultBackup[];
		uploadFail?: Set<string>;
		decryptFail?: Set<string>;
	} = {},
) {
	let store = initial;
	const uploaded: string[] = [];
	let lastVaults: VaultBackup[] = [];
	const deps: ScheduledBackupDeps = {
		loadTargets: async () => store,
		saveTargets: async (t) => {
			store = t;
		},
		readVaults: async () => opts.vaults ?? ONE_VAULT,
		hashVaults: async () => opts.hash ?? "CUR",
		decryptSecrets: async (creds) => {
			if (opts.decryptFail?.has(creds.iv)) throw new Error("bad creds");
			return { accessKeyId: "k", secretAccessKey: "s" };
		},
		upload: async (t, _secrets, vaults) => {
			if (opts.uploadFail?.has(t.id)) throw new Error("upload boom");
			uploaded.push(t.id);
			lastVaults = vaults;
		},
	};
	return { deps, uploaded, current: () => store, uploadedVaults: () => lastVaults };
}

describe("runScheduledBackups", () => {
	it("uploads a due+changed target and records success", async () => {
		const h = harness([target("a", "daily", { lastVaultHash: "OLD" })], { hash: "CUR" });
		const res = await runScheduledBackups(h.deps, NOW);
		expect(h.uploaded).toEqual(["a"]);
		expect(res).toEqual({ attempted: 1, succeeded: ["a"], failed: [] });
		const saved = h.current()[0];
		expect(saved?.lastBackupAt).toBe(NOW);
		expect(saved?.lastVaultHash).toBe("CUR");
		expect(saved?.lastError).toBeUndefined();
	});

	it("hands every vault to the target's upload (not just the primary)", async () => {
		const vaults: VaultBackup[] = [
			{ id: "a", blob: new Uint8Array([1]), legacy: true },
			{ id: "b", blob: new Uint8Array([2]), legacy: false },
		];
		const h = harness([target("t", "daily", { lastVaultHash: "OLD" })], { hash: "CUR", vaults });
		await runScheduledBackups(h.deps, NOW);
		expect(h.uploadedVaults().map((v) => v.id)).toEqual(["a", "b"]);
	});

	it("does nothing when no target is due", async () => {
		const h = harness(
			[
				target("a", "off", { lastVaultHash: "OLD" }),
				target("b", "weekly", { lastBackupAt: NOW - DAY, lastVaultHash: "OLD" }),
			],
			{ hash: "CUR" },
		);
		const res = await runScheduledBackups(h.deps, NOW);
		expect(h.uploaded).toEqual([]);
		expect(res).toEqual({ attempted: 0, succeeded: [], failed: [] });
	});

	it("skips a due-but-unchanged target (no upload)", async () => {
		const h = harness(
			[target("a", "daily", { lastBackupAt: NOW - 2 * DAY, lastVaultHash: "CUR" })],
			{
				hash: "CUR",
			},
		);
		const res = await runScheduledBackups(h.deps, NOW);
		expect(h.uploaded).toEqual([]);
		expect(res.attempted).toBe(0);
	});

	it("records a failed upload without advancing lastBackupAt; others still succeed", async () => {
		const h = harness(
			[
				target("a", "daily", { lastVaultHash: "OLD", lastBackupAt: 111 }),
				target("b", "daily", { lastVaultHash: "OLD" }),
			],
			{ hash: "CUR", uploadFail: new Set(["a"]) },
		);
		const res = await runScheduledBackups(h.deps, NOW);
		expect(h.uploaded).toEqual(["b"]);
		expect(res.failed).toEqual([{ id: "a", error: "upload boom" }]);
		const a = h.current().find((t) => t.id === "a");
		const b = h.current().find((t) => t.id === "b");
		expect(a?.lastBackupAt).toBe(111); // NOT advanced
		expect(a?.lastError).toBe("upload boom");
		expect(b?.lastBackupAt).toBe(NOW);
		expect(b?.lastError).toBeUndefined();
	});

	it("records a credential-decrypt failure as a failed target", async () => {
		const h = harness([target("a", "daily", { lastVaultHash: "OLD" })], {
			hash: "CUR",
			decryptFail: new Set(["a"]),
		});
		const res = await runScheduledBackups(h.deps, NOW);
		expect(h.uploaded).toEqual([]);
		expect(res.failed).toEqual([{ id: "a", error: "bad creds" }]);
		expect(h.current()[0]?.lastError).toBe("bad creds");
	});
});
