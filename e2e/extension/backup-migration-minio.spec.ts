import { expect, test } from "./fixtures";
import {
	backgroundWorker,
	createVault,
	expectUnlocked,
	gotoBackups,
	localStorageKeys,
	lockToPicker,
	openPopup,
	selectVault,
} from "./helpers";
import { fillS3Form, s3Keys } from "./it-servers";

// The device-global -> per-vault backup migration (issue #49), against a real S3 server.
//
// per-vault-backup.spec.ts already covers where the keys move and what the panel shows, with a
// placeholder credential and no server anywhere. What that cannot cover is whether a migrated
// target still WORKS, which is the part a user notices: the migration copies each target verbatim,
// credentials included, and those credentials are sealed under the VEK of whichever vault
// configured them. So this one drives the real Settings form against MinIO, takes a backup,
// rewrites storage into the pre-upgrade shape, and takes another one on the other side of the
// migration. A backup that lands in the bucket is the assertion; the UI only says it tried.
//
//   docker compose up -d minio minio-init
//   pnpm --filter @vault/platform-extension run build:chromium
//   BRAMBLE_IT=1 pnpm exec playwright test backup-migration-minio
//
// Skipped without BRAMBLE_IT, like the provider integration suite: a machine with no containers
// stays green rather than failing for a reason that is not about the code.

/** A folder of its own per run, so a failed run cannot poison the next one. */
const PREFIX = `e2e-migration-${Date.now().toString(36)}`;

/** Every registered vault id, in registry order (the first is the default vault). */
async function vaultIds(context: Parameters<typeof backgroundWorker>[0]): Promise<string[]> {
	const sw = await backgroundWorker(context);
	return sw.evaluate(async () => {
		const reg = (await chrome.storage.local.get("vault.registry"))["vault.registry"] as {
			vaults: { id: string }[];
		};
		return reg.vaults.map((v) => v.id);
	});
}

test.describe("cloud backup migration", () => {
	test.skip(
		!process.env.BRAMBLE_IT,
		"needs MinIO: `docker compose up -d minio minio-init`, then BRAMBLE_IT=1",
	);
	// Two vaults, two real backups and a container round trip per assertion.
	test.setTimeout(180_000);

	test("a migrated target still backs up the vault that configured it", async ({
		context,
		extensionId,
	}) => {
		const setup = await context.newPage();
		await createVault(setup, extensionId);
		const setup2 = await context.newPage();
		await createVault(setup2, extensionId);
		const [firstVault, secondVault] = await vaultIds(context);

		// Vault 2 is current after creating it, so switch back: vault 1 is the one that configures
		// the target, which is what makes the other vault's copy of it interesting later.
		const popup = await context.newPage();
		await openPopup(popup, extensionId);
		await expectUnlocked(popup);
		await lockToPicker(popup);
		await selectVault(popup, /Vault 1/);
		await gotoBackups(popup);

		// Through the real form, not a seeded fixture: the credential has to be sealed the way the
		// app seals it, or the run on the other side of the migration would prove nothing.
		await fillS3Form(popup, PREFIX);
		await popup.getByRole("button", { name: "Save" }).click();

		// It works before the migration. Without this the test could not tell a migration that
		// broke the target from a target that never worked.
		await popup.getByRole("button", { name: /Back up now/i }).click();
		await expect(popup.getByText(/Last backed up/i)).toBeVisible();
		const before = s3Keys(PREFIX);
		expect(before).toHaveLength(1);

		// Now the pre-upgrade profile, built from the working target rather than written by hand:
		// one device-global list, no per-vault keys. This is what an extension updated from 1.16
		// has on disk, credentials and all.
		const sw = await backgroundWorker(context);
		await sw.evaluate(
			async (keys) => {
				const perVault = keys as string[];
				const got = await chrome.storage.local.get(perVault[0]);
				await chrome.storage.local.set({ "backup.targets": got[perVault[0]] });
				await chrome.storage.local.remove(perVault);
			},
			[`backup.targets:${firstVault}`, `backup.targets:${secondVault}`],
		);

		// Opening the panel is what runs the migration.
		await popup.reload();
		await expectUnlocked(popup);
		await gotoBackups(popup);
		await expect(popup.getByText(/Last backed up|Back up now/i).first()).toBeVisible();

		// Both vaults hold a copy, and the global key is gone.
		const keys = await localStorageKeys(context);
		expect(keys).not.toContain("backup.targets");
		expect(keys.filter((k) => k.startsWith("backup.targets:")).sort()).toEqual(
			[`backup.targets:${firstVault}`, `backup.targets:${secondVault}`].sort(),
		);

		// The point of the whole test: the copy vault 1 kept is still usable. Same bucket, same
		// folder, and a second snapshot beside the first rather than an error in the panel.
		//
		// A second of daylight first, deliberately. The object key carries a timestamp to the
		// second and a hash of the blob, and the blob has not changed between these two runs, so
		// two backups inside one second would write the same key and the second would overwrite
		// the first: one object where the test wants two, for a reason that is about the clock.
		await popup.waitForTimeout(1_100);
		await popup.getByRole("button", { name: /Back up now/i }).click();
		await expect(popup.getByText(/Last backed up/i)).toBeVisible();
		await expect(popup.getByText(/failed|error|denied/i)).toHaveCount(0);
		await expect.poll(() => s3Keys(PREFIX).length, { timeout: 30_000, intervals: [2_000] }).toBe(2);

		// And it landed the way a migrated target is supposed to land. Keys are
		// `bramble-<stamp>-<hash>[-v<vault>].bramble`, and the marker is where the migration shows
		// up in the bucket: a target that belongs to one vault tags its snapshots with that vault,
		// where a migrated one must not, because the folder it inherited is full of untagged
		// snapshots and tagging only the new ones would leave the old ones unprunable. Keys sort
		// chronologically by construction, so this is the before and the after.
		const [tagged, untagged] = s3Keys(PREFIX).sort();
		expect(tagged).toMatch(/^bramble-\d{8}T\d{6}Z-[0-9a-f]{8}-v[0-9a-z]+\.bramble$/);
		expect(untagged).toMatch(/^bramble-\d{8}T\d{6}Z-[0-9a-f]{8}\.bramble$/);
	});
});
