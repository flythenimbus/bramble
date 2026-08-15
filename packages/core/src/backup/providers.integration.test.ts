// The provider clients against REAL servers, not stubs.
//
// Everything else in this directory tests our logic with fetch mocked out, which cannot catch the
// failures that actually happen with a backup provider: a signature a server rejects, a PROPFIND
// whose XML we parse wrongly, a listing that comes back in a shape the parser has never seen, a
// prune that deletes the wrong keys. Those only show up against something that implements the
// protocol, so this suite drives Nextcloud and MinIO out of `docker compose`.
//
//   docker compose up -d          # then wait for Nextcloud's first-boot install
//   BRAMBLE_IT=1 pnpm --filter @vault/core exec vitest run providers.integration
//
// Skipped unless BRAMBLE_IT is set, so a normal `pnpm test` on a machine with no containers stays
// green rather than failing for a reason that is not about the code.

import { describe, expect, it } from "vitest";
import { runBackup, selectForPruning } from "./orchestrator";
import { createS3Target } from "./s3";
import type { BackupTarget } from "./types";
import { createWebdavTarget } from "./webdav";

// Read through globalThis rather than the `process` global: this file is typechecked by the
// extension and mobile projects too, and neither has node types.
const env: Record<string, string | undefined> =
	(globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

const ENABLED = Boolean(env.BRAMBLE_IT);
const suite = ENABLED ? describe : describe.skip;

const WEBDAV = {
	kind: "webdav",
	serverUrl: env.BRAMBLE_IT_WEBDAV ?? "http://localhost:8080/remote.php/dav/files/admin/",
	username: env.BRAMBLE_IT_WEBDAV_USER ?? "admin",
	password: env.BRAMBLE_IT_WEBDAV_PASS ?? "Bramble-test-123",
} as const;

const S3 = {
	kind: "s3",
	endpoint: env.BRAMBLE_IT_S3 ?? "http://localhost:9000",
	region: "us-east-1",
	bucket: env.BRAMBLE_IT_S3_BUCKET ?? "bramble-test",
	accessKeyId: env.BRAMBLE_IT_S3_KEY ?? "bramble",
	secretAccessKey: env.BRAMBLE_IT_S3_SECRET ?? "bramble-test-secret",
} as const;

// A fresh folder per run, so a failed run cannot poison the next one and two runs can overlap.
const folder = () =>
	`it-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;

const blob = (s: string) => new TextEncoder().encode(s);

/** Delete everything this test wrote, whatever happened. */
async function cleanup(target: BackupTarget, prefix: string): Promise<void> {
	try {
		for (const o of await target.list(`${prefix}/`)) await target.remove(o.key).catch(() => {});
	} catch {}
}

/** The round trip every provider has to survive, run against each of them. */
function contract(name: string, make: () => BackupTarget) {
	describe(name, () => {
		it("uploads, lists, reads back the same bytes, and removes", async () => {
			const target = make();
			const prefix = folder();
			try {
				const bytes = blob("sealed vault bytes");
				const result = await runBackup(target, bytes, { prefix, keep: 30 });

				const listed = await target.list(`${prefix}/`);
				expect(listed.map((o) => o.key)).toContain(result.key);
				// Size is what a retention decision reads, so a provider reporting it wrongly matters.
				expect(listed.find((o) => o.key === result.key)?.size).toBe(bytes.byteLength);
				// The bytes have to come back identical: this is a backup.
				expect(await target.get(result.key)).toEqual(bytes);

				await target.remove(result.key);
				expect((await target.list(`${prefix}/`)).map((o) => o.key)).not.toContain(result.key);
			} finally {
				await cleanup(target, prefix);
			}
		}, 60_000);

		it("prunes to keep-N against the server's own listing", async () => {
			const target = make();
			const prefix = folder();
			try {
				for (let day = 1; day <= 4; day++) {
					await runBackup(target, blob(`vault-${day}`), {
						prefix,
						keep: 2,
						now: new Date(Date.UTC(2026, 0, day)),
					});
				}
				const left = (await target.list(`${prefix}/`)).map((o) => o.key).sort();
				expect(left).toHaveLength(2);
				expect(left.every((k) => k.includes("20260103") || k.includes("20260104"))).toBe(true);
			} finally {
				await cleanup(target, prefix);
			}
		}, 120_000);

		// The data-loss case the adversarial review found. Two vaults, one folder: each prune must
		// see only its own snapshots, which is a property of the keys as the SERVER lists them.
		it("keeps two vaults sharing one folder out of each other's retention", async () => {
			const target = make();
			const prefix = folder();
			const A = "aaaaaaaa-0000-4000-8000-000000000000";
			const B = "bbbbbbbb-0000-4000-8000-000000000000";
			try {
				await runBackup(target, blob("vault-A"), {
					prefix,
					keep: 1,
					vaultId: A,
					now: new Date(Date.UTC(2026, 0, 1)),
				});
				for (let day = 2; day <= 4; day++) {
					await runBackup(target, blob(`vault-B-${day}`), {
						prefix,
						keep: 1,
						vaultId: B,
						now: new Date(Date.UTC(2026, 0, day)),
					});
				}
				const keys = (await target.list(`${prefix}/`)).map((o) => o.key);
				// B kept its newest and pruned its own older two; A's single snapshot survived all of
				// it, which is the whole point.
				expect(keys.filter((k) => k.includes("-vaaaaaaaa."))).toHaveLength(1);
				expect(keys.filter((k) => k.includes("-vbbbbbbbb."))).toHaveLength(1);
				// And the pure function agrees with what the server actually holds.
				const objects = await target.list(`${prefix}/`);
				expect(selectForPruning(objects, 1, A)).toEqual([]);
			} finally {
				await cleanup(target, prefix);
			}
		}, 120_000);
	});
}

suite("provider integration", () => {
	contract("WebDAV (Nextcloud)", () => createWebdavTarget(WEBDAV));
	// MinIO validates SigV4 strictly, which is the point: it is the only check that the signer
	// agrees with a real S3 implementation rather than only with our own vectors.
	contract("S3 (MinIO)", () => createS3Target(S3));
});
