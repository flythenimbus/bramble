import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import {
	gotoBackups,
	lock,
	openExampleLogin,
	optionsUrl,
	STRONG_PW,
	selectVault,
	unlock,
} from "./helpers";
import { fillS3Form, mc, S3, s3Keys } from "./it-servers";

// A scheduled backup of a vault with attachments, against real servers, end to end.
//
// The path under test is the one a user never watches: the background worker plans the backup,
// the crypto host's offscreen document uploads it (a Chrome worker cannot hold a long upload
// open), as an S3 multipart upload or one streamed WebDAV PUT. What lands on the server is then
// read back with a different client from ours (`mc`, `curl`), checked by `unzip`, and restored in
// the app, and the attachments have to open byte for byte. Nothing short of that proves the
// backup whole.
//
//   docker compose up -d
//   pnpm --filter @vault/platform-extension run build:chromium
//   BRAMBLE_IT=1 pnpm exec playwright test backup-attachments-servers

const DAV = {
	url: process.env.BRAMBLE_IT_WEBDAV ?? "http://localhost:8080/remote.php/dav/files/admin/",
	user: process.env.BRAMBLE_IT_WEBDAV_USER ?? "admin",
	pass: process.env.BRAMBLE_IT_WEBDAV_PASS ?? "Bramble-test-123",
};

const runId = Date.now().toString(36);

function curl(args: string[]): Buffer {
	return execFileSync("curl", ["-s", "-f", "-u", `${DAV.user}:${DAV.pass}`, ...args], {
		maxBuffer: 512 * 1024 * 1024,
	});
}

/** The two kinds of target, each with its own way to read the server back. */
const PROVIDERS = [
	{
		name: "S3 (MinIO), in parts",
		folder: `e2e-attachments-s3-${runId}`,
		configure: fillS3Form,
		list: (folder: string) => s3Keys(folder).filter((key) => key.endsWith(".bramble")),
		fetch: (folder: string, name: string) => mc(`mc cat local/${S3.bucket}/${folder}/${name}`),
	},
	{
		name: "WebDAV (Nextcloud), streamed",
		folder: `e2e-attachments-dav-${runId}`,
		async configure(popup: Page, folder: string) {
			await popup.getByRole("button", { name: /Nextcloud/i }).click();
			await popup.getByLabel("WebDAV URL").fill(DAV.url);
			await popup.getByLabel("Username").fill(DAV.user);
			await popup.getByLabel("Password", { exact: true }).fill(DAV.pass);
			await popup.getByLabel(/Backup folder/i).fill(`/${folder}`);
		},
		list(folder: string): string[] {
			let xml = "";
			try {
				xml = curl(["-X", "PROPFIND", "-H", "Depth: 1", `${DAV.url}${folder}/`]).toString("utf8");
			} catch {
				return []; // the folder does not exist yet
			}
			return [...xml.matchAll(/<d:href>[^<]*\/(bramble-[^</]*\.bramble)<\/d:href>/g)].map(
				(m) => m[1] as string,
			);
		},
		fetch: (folder: string, name: string) => curl([`${DAV.url}${folder}/${name}`]),
	},
];

// Two attachments of 60 MB: past the 16 MB part size, so the S3 archive goes up in parts and
// the WebDAV one streams, and past the 100 MB that backups were once capped at, over which a
// vault used to go up without them.
function pattern(len: number, seed: number): Buffer {
	const out = Buffer.alloc(len);
	for (let i = 0; i < len; i++) out[i] = (i * seed + (i >> 12)) % 251;
	return out;
}
const FILES = [
	{ name: "scan-front.bin", body: pattern(60 * 1024 * 1024, 7) },
	{ name: "scan-back.bin", body: pattern(60 * 1024 * 1024 + 4321, 13) },
];

test.describe("scheduled backup with attachments", () => {
	test.skip(
		!process.env.BRAMBLE_IT,
		"needs the compose servers: `docker compose up -d`, then BRAMBLE_IT=1",
	);
	test.setTimeout(420_000);

	for (const provider of PROVIDERS) {
		test(`${provider.name}: goes up whole from the background and restores byte for byte`, async ({
			context,
			extensionId,
		}) => {
			const popup = await openExampleLogin(context, extensionId, { detached: true });
			// From disk: Playwright takes nothing over 50 MB as an in-memory buffer.
			const sources = mkdtempSync(path.join(tmpdir(), "bramble-attach-"));
			for (const f of FILES) {
				const source = path.join(sources, f.name);
				writeFileSync(source, f.body);
				await popup.locator('input[type="file"]').setInputFiles(source);
				await expect(popup.getByText(f.name)).toBeVisible({ timeout: 60_000 });
			}

			await popup.getByRole("button", { name: "Go to vault" }).click();
			await gotoBackups(popup);
			await provider.configure(popup, provider.folder);
			await popup.getByRole("button", { name: "Save" }).click();

			// Not "Back up now": an unlock is what starts the scheduled run, in the background.
			await lock(popup);
			await unlock(popup);
			await expect
				.poll(() => provider.list(provider.folder).length, { timeout: 180_000, intervals: [3_000] })
				.toBe(1);

			const [name] = provider.list(provider.folder);
			const dir = mkdtempSync(path.join(tmpdir(), "bramble-backup-"));
			const file = path.join(dir, "backup.bramble");
			writeFileSync(file, provider.fetch(provider.folder, name as string));
			// A ZIP that a stock tool accepts, CRCs and all, holding the vault and both files.
			expect(readFileSync(file).length).toBeGreaterThan(100 * 1024 * 1024);
			const listing = execFileSync("unzip", ["-l", file], { encoding: "utf8" });
			expect(listing).toContain("vault.bramble");
			expect((listing.match(/blobs\/[0-9a-f]{64}/g) ?? []).length).toBe(2);
			execFileSync("unzip", ["-tq", file]);

			// And it restores: a new vault whose attachments open as the originals.
			const restore = await context.newPage();
			await restore.goto(`${optionsUrl(extensionId)}?screen=restore`);
			await restore.locator('input[type="file"]').setInputFiles(file);
			await expect(restore.getByText(/as a new vault/i)).toBeVisible();
			await restore.locator('input[type="password"]').first().fill(STRONG_PW);
			await restore.getByRole("button", { name: /Restore vault/i }).click();
			await expect(restore.getByRole("heading", { name: /Vault added/i })).toBeVisible({
				timeout: 60_000,
			});

			await popup.reload();
			await popup.getByRole("button", { name: /Choose a different vault/i }).click();
			await selectVault(popup, /Vault 2/);
			await popup.getByText("Example Login").click();
			for (const f of FILES) {
				// The innermost element holding both the name and its Open button: that file's row.
				const row = popup
					.locator("div")
					.filter({ hasText: f.name })
					.filter({ has: popup.getByRole("button", { name: "Open attachment" }) })
					.last();
				const downloading = popup.waitForEvent("download");
				await row.getByRole("button", { name: "Open attachment" }).click();
				const saved = readFileSync((await (await downloading).path()) as string);
				expect(saved.equals(f.body)).toBe(true);
			}
		});
	}
});
