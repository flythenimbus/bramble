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

const ONE_VAULT: VaultBackup[] = [{ id: "v1", blob: new Uint8Array([1, 2, 3]), isDefault: true }];

// In-memory fakes. `byVault` is each vault's own target list; `uploadFail` and `locked` are keyed
// by target id and vault id. `hash` is per vault, defaulting to "CUR".
function harness(
	byVault: Record<string, BackupTargetConfig[]>,
	opts: {
		hashes?: Record<string, string>;
		vaults?: VaultBackup[];
		uploadFail?: Set<string>;
		locked?: Set<string>;
	} = {},
) {
	const store: Record<string, BackupTargetConfig[]> = { ...byVault };
	const uploaded: { vaultId: string; id: string; blob: Uint8Array }[] = [];
	const deps: ScheduledBackupDeps = {
		listVaults: async () => opts.vaults ?? ONE_VAULT,
		loadTargets: async (vaultId) => store[vaultId] ?? [],
		saveTargets: async (vaultId, targets) => {
			store[vaultId] = targets;
		},
		hashVault: async (v) => opts.hashes?.[v.id] ?? "CUR",
		decryptSecrets: async (vaultId) =>
			opts.locked?.has(vaultId) ? null : { accessKeyId: "k", secretAccessKey: "s" },
		upload: async (vaultId, t, _secrets, vault) => {
			if (opts.uploadFail?.has(t.id)) throw new Error("upload boom");
			uploaded.push({ vaultId, id: t.id, blob: vault.blob });
		},
	};
	return { deps, uploaded, current: (vaultId: string) => store[vaultId] ?? [] };
}

const TWO_VAULTS: VaultBackup[] = [
	{ id: "a", blob: new Uint8Array([1]), isDefault: true },
	{ id: "b", blob: new Uint8Array([2]), isDefault: false },
];

describe("runScheduledBackups", () => {
	it("uploads a due+changed target and records success", async () => {
		const h = harness({ v1: [target("a", "daily", { lastVaultHash: "OLD" })] });
		const res = await runScheduledBackups(h.deps, NOW);
		expect(h.uploaded.map((u) => u.id)).toEqual(["a"]);
		expect(res).toEqual({
			attempted: 1,
			succeeded: [{ vaultId: "v1", id: "a" }],
			failed: [],
			skipped: 0,
		});
		const saved = h.current("v1")[0];
		expect(saved?.lastBackupAt).toBe(NOW);
		expect(saved?.lastVaultHash).toBe("CUR");
		expect(saved?.lastError).toBeUndefined();
	});

	// The issue-#49 invariant: a target belongs to one vault, and only ever sees that vault's blob.
	it("backs up each vault to its own targets only", async () => {
		const h = harness(
			{
				a: [target("ta", "daily", { lastVaultHash: "OLD" })],
				b: [target("tb", "daily", { lastVaultHash: "OLD" })],
			},
			{ vaults: TWO_VAULTS },
		);
		await runScheduledBackups(h.deps, NOW);
		expect(h.uploaded).toEqual([
			{ vaultId: "a", id: "ta", blob: TWO_VAULTS[0]?.blob },
			{ vaultId: "b", id: "tb", blob: TWO_VAULTS[1]?.blob },
		]);
	});

	// Each vault's own fingerprint gates its own targets: editing one vault must not re-upload
	// another whose bytes did not change.
	it("skips a vault whose hash is unchanged while another vault still runs", async () => {
		const h = harness(
			{
				a: [target("ta", "daily", { lastVaultHash: "SAME" })],
				b: [target("tb", "daily", { lastVaultHash: "OLD" })],
			},
			{ vaults: TWO_VAULTS, hashes: { a: "SAME", b: "NEW" } },
		);
		const res = await runScheduledBackups(h.deps, NOW);
		expect(h.uploaded.map((u) => u.id)).toEqual(["tb"]);
		expect(res.attempted).toBe(1);
	});

	// A locked vault cannot unwrap its own target credentials. That is a "not yet", not a failure:
	// no error is painted in the UI and the target stays due for the next unlock.
	it("skips a locked vault's targets without recording an error", async () => {
		const h = harness(
			{
				a: [target("ta", "daily", { lastVaultHash: "OLD" })],
				b: [target("tb", "daily", { lastVaultHash: "OLD", lastBackupAt: 111 })],
			},
			{ vaults: TWO_VAULTS, locked: new Set(["b"]) },
		);
		const res = await runScheduledBackups(h.deps, NOW);
		expect(h.uploaded.map((u) => u.id)).toEqual(["ta"]);
		expect(res.skipped).toBe(1);
		expect(res.failed).toEqual([]);
		const tb = h.current("b")[0];
		expect(tb?.lastError).toBeUndefined();
		expect(tb?.lastBackupAt).toBe(111); // still due
	});

	// The desktop keeps credentials in the OS credential store, so a run needs no vault key at
	// all: that is what lets a locked vault still meet its schedule there.
	it("uploads a target whose credentials the OS holds without decrypting anything", async () => {
		const h = harness({
			v1: [target("a", "daily", { lastVaultHash: "OLD", creds: { wrap: "os" } })],
		});
		h.deps.decryptSecrets = async () => {
			throw new Error("must not be asked to decrypt an OS-held credential");
		};
		const res = await runScheduledBackups(h.deps, NOW);
		expect(h.uploaded.map((u) => u.id)).toEqual(["a"]);
		expect(res.succeeded).toEqual([{ vaultId: "v1", id: "a" }]);
		expect(h.current("v1")[0]?.lastBackupAt).toBe(NOW);
	});

	it("does nothing when no target is due", async () => {
		const h = harness({
			v1: [
				target("a", "off", { lastVaultHash: "OLD" }),
				target("b", "weekly", { lastBackupAt: NOW - DAY, lastVaultHash: "OLD" }),
			],
		});
		const res = await runScheduledBackups(h.deps, NOW);
		expect(h.uploaded).toEqual([]);
		expect(res).toEqual({ attempted: 0, succeeded: [], failed: [], skipped: 0 });
	});

	it("skips a due-but-unchanged target (no upload)", async () => {
		const h = harness({
			v1: [target("a", "daily", { lastBackupAt: NOW - 2 * DAY, lastVaultHash: "CUR" })],
		});
		const res = await runScheduledBackups(h.deps, NOW);
		expect(h.uploaded).toEqual([]);
		expect(res.attempted).toBe(0);
	});

	it("records a failed upload without advancing lastBackupAt; others still succeed", async () => {
		const h = harness(
			{
				v1: [
					target("a", "daily", { lastVaultHash: "OLD", lastBackupAt: 111 }),
					target("b", "daily", { lastVaultHash: "OLD" }),
				],
			},
			{ uploadFail: new Set(["a"]) },
		);
		const res = await runScheduledBackups(h.deps, NOW);
		expect(h.uploaded.map((u) => u.id)).toEqual(["b"]);
		expect(res.failed).toEqual([{ vaultId: "v1", id: "a", error: "upload boom" }]);
		const a = h.current("v1").find((t) => t.id === "a");
		const b = h.current("v1").find((t) => t.id === "b");
		expect(a?.lastBackupAt).toBe(111); // NOT advanced
		expect(a?.lastError).toBe("upload boom");
		expect(b?.lastBackupAt).toBe(NOW);
		expect(b?.lastError).toBeUndefined();
	});

	it("records a credential-decrypt error as a failed target", async () => {
		const h = harness({ v1: [target("a", "daily", { lastVaultHash: "OLD" })] });
		h.deps.decryptSecrets = async () => {
			throw new Error("bad creds");
		};
		const res = await runScheduledBackups(h.deps, NOW);
		expect(h.uploaded).toEqual([]);
		expect(res.failed).toEqual([{ vaultId: "v1", id: "a", error: "bad creds" }]);
		expect(h.current("v1")[0]?.lastError).toBe("bad creds");
	});
});

// The pieces composed: isDue holds a failed target off, applyBackupOutcomes counts the failures,
// and a success clears both. Unit tests cover each half; this is the loop the desktop tick runs.
describe("runScheduledBackups: retry backoff", () => {
	it("stops retrying a failing target every tick", async () => {
		const h = harness({ v1: [target("t1", "daily")] }, { uploadFail: new Set(["t1"]) });

		const first = await runScheduledBackups(h.deps, NOW);
		expect(first.failed).toHaveLength(1);
		expect(h.current("v1")[0]).toMatchObject({ failures: 1, failedAt: NOW });

		// Five minutes later, the next tick. Before the backoff this attempted again, and would
		// have gone on doing so twelve times an hour for as long as the credential stayed wrong.
		const soon = await runScheduledBackups(h.deps, NOW + 5 * 60 * 1000);
		expect(soon.attempted).toBe(0);
		expect(h.current("v1")[0]?.failures).toBe(1);

		// Past the first delay it tries once more, and fails again, so the next wait is longer.
		const later = await runScheduledBackups(h.deps, NOW + 16 * 60 * 1000);
		expect(later.failed).toHaveLength(1);
		expect(h.current("v1")[0]?.failures).toBe(2);
	});

	it("resumes as normal once a run succeeds", async () => {
		const failing = new Set(["t1"]);
		const h = harness({ v1: [target("t1", "daily")] }, { uploadFail: failing });

		await runScheduledBackups(h.deps, NOW);
		expect(h.current("v1")[0]?.failures).toBe(1);

		// The user fixes the credential. (Editing the target clears the backoff too; this covers
		// the other route, where whatever was broken simply recovers.)
		failing.delete("t1");
		const ok = await runScheduledBackups(h.deps, NOW + 16 * 60 * 1000);
		expect(ok.succeeded).toHaveLength(1);
		expect(h.current("v1")[0]).toMatchObject({
			failures: undefined,
			failedAt: undefined,
			lastError: undefined,
		});
	});

	// A locked vault is a skip, not a failure: backing it off would delay the very run it is
	// waiting for, and nothing about the target is wrong.
	it("does not back off a target whose vault is locked", async () => {
		const h = harness({ v1: [target("t1", "daily")] }, { locked: new Set(["v1"]) });
		const r = await runScheduledBackups(h.deps, NOW);
		expect(r.skipped).toBe(1);
		expect(h.current("v1")[0]?.failures).toBeUndefined();
	});

	// One target's backoff must not stall the vault's other destinations, nor stop the vault
	// being looked at: the run loop skips a whole vault when none of its targets is due.
	it("keeps backing up other targets beside a backed-off one", async () => {
		const h = harness(
			{ v1: [target("bad", "daily"), target("good", "daily")] },
			{ uploadFail: new Set(["bad"]) },
		);
		await runScheduledBackups(h.deps, NOW);
		expect(h.uploaded.map((u) => u.id)).toEqual(["good"]);

		// A destination added five minutes later, while `bad` is still inside its first backoff.
		h.current("v1").push(target("fresh", "daily"));
		const next = await runScheduledBackups(h.deps, NOW + 5 * 60 * 1000);
		expect(next.succeeded.map((s) => s.id)).toEqual(["fresh"]);
		expect(next.failed).toHaveLength(0);
	});
});
