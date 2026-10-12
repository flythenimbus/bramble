import type { BrowserContext, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { addLogin, backgroundWorker, createVault, lock, openPopup, unlock } from "./helpers";

// A vault holding an entry sealed under another vault's key (what the cross-vault sync bug left
// behind) must open normally, with that entry set aside rather than a raw "aead::Error".

type Payload = { entries: unknown[]; tombstones: unknown[] };

/** A vault's decrypted outer payload, read through the extension's own crypto (its key must be loaded). */
async function readPayload(page: Page, vaultId: string): Promise<Payload> {
	return page.evaluate(async (id) => {
		const key = `vault-blob-b64:${id}`;
		const b64 = (await chrome.storage.local.get(key))[key] as string;
		const b = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
		// Entries start after the 6-byte header and every slot.
		let off = 6;
		for (let i = 0; i < (b[5] ?? 0); i++) off += 3 + (((b[off + 1] ?? 0) << 8) | (b[off + 2] ?? 0));
		const enc = (u: Uint8Array) => btoa(String.fromCharCode(...u));
		const r = await chrome.runtime.sendMessage({
			type: "CRYPTO_DECRYPT_OUTER",
			vaultId: id,
			payload: { iv: enc(b.subarray(off, off + 12)), ciphertext: enc(b.subarray(off + 12)) },
		});
		return JSON.parse(r.data);
	}, vaultId);
}

/** Re-seal a payload under the vault's loaded key and write it back, keeping the slot header. */
async function writePayload(page: Page, vaultId: string, payload: Payload): Promise<void> {
	await page.evaluate(
		async ({ id, json }) => {
			const key = `vault-blob-b64:${id}`;
			const b64 = (await chrome.storage.local.get(key))[key] as string;
			const b = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
			let off = 6;
			for (let i = 0; i < (b[5] ?? 0); i++) {
				off += 3 + (((b[off + 1] ?? 0) << 8) | (b[off + 2] ?? 0));
			}
			const r = await chrome.runtime.sendMessage({
				type: "CRYPTO_ENCRYPT_OUTER",
				vaultId: id,
				payload: { plaintext: json },
			});
			const dec = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
			const out = new Uint8Array([
				...b.subarray(0, off),
				...dec(r.data.iv),
				...dec(r.data.ciphertext),
			]);
			await chrome.storage.local.set({ [key]: btoa(String.fromCharCode(...out)) });
		},
		{ id: vaultId, json: JSON.stringify(payload) },
	);
}

async function vaultIds(context: BrowserContext): Promise<string[]> {
	const sw = await backgroundWorker(context);
	return sw.evaluate(async () => {
		const reg = (await chrome.storage.local.get("vault.registry"))["vault.registry"] as {
			vaults: { id: string }[];
		};
		return reg.vaults.map((v) => v.id);
	});
}

/** The popup on its vault list, whichever screen it restored. */
async function showList(page: Page, extensionId: string): Promise<void> {
	await openPopup(page, extensionId);
	const goToVault = page.getByRole("button", { name: "Go to vault" });
	if (await goToVault.isVisible().catch(() => false)) await goToVault.click();
	await expect(page.getByRole("button", { name: /Add New/i })).toBeVisible();
}

/** Vault 1 holding one login "Stray", then vault 2 created after it (active and unlocked). */
async function twoVaults(context: BrowserContext, page: Page, extensionId: string) {
	await createVault(page, extensionId);
	await showList(page, extensionId);
	await addLogin(page, "Stray");
	const [first] = await vaultIds(context);
	const stray = (await readPayload(page, first as string)).entries[0];
	expect(stray).toBeDefined();
	await createVault(await context.newPage(), extensionId);
	const second = (await vaultIds(context)).find((id) => id !== first) as string;
	return { stray, second };
}

async function quarantined(context: BrowserContext, vaultId: string): Promise<unknown[]> {
	const sw = await backgroundWorker(context);
	const raw = await sw.evaluate(
		async (k) => (await chrome.storage.local.get(k))[k] as string | undefined,
		`vault-quarantine:${vaultId}`,
	);
	return raw ? (JSON.parse(raw) as unknown[]) : [];
}

test("a vault holding another vault's entry opens without an error and sets it aside", async ({
	context,
	extensionId,
	page,
}) => {
	const { stray, second } = await twoVaults(context, page, extensionId);
	await showList(page, extensionId);
	await addLogin(page, "Mine");
	const payload = await readPayload(page, second);
	await writePayload(page, second, { ...payload, entries: [...payload.entries, stray] });

	await lock(page);
	await unlock(page);
	await expect(page.getByText("Mine")).toBeVisible();
	await expect(page.getByText("Stray")).toHaveCount(0);
	await expect(page.getByText(/aead::Error|aes decrypt/)).toHaveCount(0);
	expect(await quarantined(context, second)).toHaveLength(1);
});

test("a vault holding only another vault's entries opens, empty", async ({
	context,
	extensionId,
	page,
}) => {
	const { stray, second } = await twoVaults(context, page, extensionId);
	await showList(page, extensionId);
	const payload = await readPayload(page, second);
	await writePayload(page, second, { ...payload, entries: [stray] });

	await lock(page);
	await unlock(page);
	await expect(page.getByText("Stray")).toHaveCount(0);
	await expect(page.getByText(/aead::Error|aes decrypt/)).toHaveCount(0);
	expect(await quarantined(context, second)).toHaveLength(1);
});
