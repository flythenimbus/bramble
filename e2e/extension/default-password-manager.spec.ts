import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, launchExtensionContext, test } from "./fixtures";

// #135: `privacy` is optional and asked for only when the user makes Bramble the default password
// manager, so the shipped state is DECLARED BUT NOT HELD. The grant itself raises native UI that
// Playwright cannot click, so the second case holds it from install instead: what it checks is
// that the background applies a held choice against the real browser settings, which the unit
// tests can only mock.

const dir = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.resolve(dir, "../../clients/extension/dist-chromium");

test("ships without the privacy grant", async ({ context }) => {
	const [sw] = context.serviceWorkers();
	const state = await sw.evaluate(async () => ({
		binding: typeof chrome.privacy,
		contains: await chrome.permissions.contains({ permissions: ["privacy"] }),
		declared: chrome.runtime.getManifest().optional_permissions ?? [],
	}));

	expect(state.declared).toContain("privacy");
	expect(state.contains).toBe(false);
	expect(state.binding).toBe("undefined");
});

test("a held grant turns off the browser's password saving and card autofill", async () => {
	const scratch = mkdtempSync(path.join(tmpdir(), "bramble-e2e-privacy-"));
	const extension = path.join(scratch, "extension");
	cpSync(BUILD, extension, { recursive: true });
	const manifestPath = path.join(extension, "manifest.json");
	const m = JSON.parse(readFileSync(manifestPath, "utf8")) as {
		permissions?: string[];
		optional_permissions?: string[];
	};
	m.permissions = [...new Set([...(m.permissions ?? []), "privacy"])];
	m.optional_permissions = (m.optional_permissions ?? []).filter((p) => p !== "privacy");
	writeFileSync(manifestPath, JSON.stringify(m));

	const { context, profileDir } = await launchExtensionContext(undefined, extension);
	try {
		const [sw] = context.serviceWorkers();
		const read = () =>
			sw.evaluate(async () => {
				const s = chrome.privacy.services as unknown as Record<
					string,
					{ get(d: object): Promise<{ levelOfControl: string; value: boolean }> }
				>;
				return {
					passwords: await s.passwordSavingEnabled.get({}),
					cards: await s.autofillCreditCardEnabled.get({}),
				};
			});
		const taken = { levelOfControl: "controlled_by_this_extension", value: false };
		await expect.poll(read).toEqual({ passwords: taken, cards: taken });
	} finally {
		await context.close();
		rmSync(profileDir, { recursive: true, force: true });
		rmSync(scratch, { recursive: true, force: true });
	}
});
