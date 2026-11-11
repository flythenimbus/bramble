import type { BrowserContext, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import {
	actOnPasskeyCard,
	addTapToUnlockKey,
	addVirtualAuthenticator,
	createVault,
	expectUnlocked,
	openPopup,
	STRONG_PW,
} from "./helpers";

// PRF through Chrome's real webAuthenticationProxy: the request Chrome hands us carries the site's
// inputs, and Chrome accepts what we answer (enabled on create, 32-byte results) and passes it to
// the page. Only a real browser proves both halves. See docs/passkey-prf.md.

function create(page: Page, salt: string) {
	return page.evaluate(async (salt) => {
		const hex = (b?: ArrayBuffer) =>
			b ? [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("") : "";
		const cred = (await navigator.credentials.create({
			publicKey: {
				rp: { id: "localhost", name: "PRF" },
				user: { id: new Uint8Array([1, 2, 3]), name: "ada", displayName: "Ada" },
				challenge: new Uint8Array(32),
				pubKeyCredParams: [{ type: "public-key", alg: -7 }],
				extensions: { prf: { eval: { first: new TextEncoder().encode(salt) } } },
			} as unknown as PublicKeyCredentialCreationOptions,
		})) as PublicKeyCredential;
		const prf = (
			cred.getClientExtensionResults() as {
				prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } };
			}
		).prf;
		return { id: cred.id, enabled: prf?.enabled, first: hex(prf?.results?.first) };
	}, salt);
}

function get(page: Page, id: string, salt: string, ownSalt?: string) {
	return page.evaluate(
		async ({ id, salt, ownSalt }) => {
			const hex = (b?: ArrayBuffer) =>
				b ? [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("") : "";
			const enc = (s: string) => new TextEncoder().encode(s);
			const rawId = Uint8Array.from(atob(id.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
				c.charCodeAt(0),
			);
			const cred = (await navigator.credentials.get({
				publicKey: {
					rpId: "localhost",
					challenge: new Uint8Array(32),
					allowCredentials: [{ type: "public-key", id: rawId }],
					extensions: {
						prf: {
							eval: { first: enc(salt) },
							...(ownSalt ? { evalByCredential: { [id]: { first: enc(ownSalt) } } } : {}),
						},
					},
				} as unknown as PublicKeyCredentialRequestOptions,
			})) as PublicKeyCredential;
			const prf = (
				cred.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } }
			).prf;
			return hex(prf?.results?.first);
		},
		{ id, salt, ownSalt },
	);
}

/**
 * A PRF ceremony on an unlocked vault: approve the card, then confirm it's you in the window the
 * provider opens (a card click is consent, not user verification), and return the page's result.
 */
async function verifiedCeremony<T>(
	context: BrowserContext,
	page: Page,
	action: "passkey-approve" | "passkey-pick",
	run: () => Promise<T>,
): Promise<T> {
	const verifyWindow = context.waitForEvent("page");
	const result = actOnPasskeyCard(page, action, run);
	const verify = await verifyWindow;
	await verify.getByLabel("Master password").fill(STRONG_PW);
	await verify.getByRole("button", { name: "Confirm", exact: true }).click();
	return result;
}

test("PRF round-trips through Chrome's webAuthenticationProxy", async ({
	context,
	extensionId,
}) => {
	const setup = await context.newPage();
	await createVault(setup, extensionId);
	await setup.evaluate(() =>
		chrome.runtime.sendMessage({
			type: "PASSKEY_PROVIDER_SET_ENABLED",
			payload: { enabled: true },
		}),
	);

	// localhost is a secure context without TLS; a routed https page counts as a certificate error,
	// and Chrome refuses WebAuthn there. Nothing listens on the port: the route answers.
	await context.route(/^http:\/\/localhost:4719\//, (route) =>
		route.fulfill({
			body: "<!doctype html><title>PRF</title><p>PRF test</p>",
			headers: { "content-type": "text/html" },
		}),
	);
	const page = await context.newPage();
	await page.goto("http://localhost:4719/");
	await page.bringToFront();

	const created = await verifiedCeremony(context, page, "passkey-approve", () =>
		create(page, "salt-a"),
	);
	expect(created.enabled).toBe(true);
	expect(created.first).toMatch(/^[0-9a-f]{64}$/);

	// Same passkey, same input: the same key at sign-in as at registration.
	const signIn = (salt: string, ownSalt?: string) =>
		verifiedCeremony(context, page, "passkey-pick", () => get(page, created.id, salt, ownSalt));
	expect(await signIn("salt-a")).toBe(created.first);

	const saltB = await signIn("salt-b");
	expect(saltB).toMatch(/^[0-9a-f]{64}$/);
	expect(saltB).not.toBe(created.first);

	// The credential's own evalByCredential entry wins over eval.
	expect(await signIn("salt-a", "salt-b")).toBe(saltB);
});

// "Confirm passkeys once per unlock": the unlock that opened the vault is the check, so a site that
// requires verification (or uses PRF) gets UV and the same keys with no confirm window.
test("once per unlock, an unlocked vault confirms without a window", async ({
	context,
	extensionId,
}) => {
	const setup = await context.newPage();
	await createVault(setup, extensionId);
	await setup.evaluate(async () => {
		await chrome.storage.local.set({ "pref.passkeyConfirmOncePerUnlock": true });
		await chrome.runtime.sendMessage({
			type: "PASSKEY_PROVIDER_SET_ENABLED",
			payload: { enabled: true },
		});
	});
	await context.route(/^http:\/\/localhost:4719\//, (route) =>
		route.fulfill({
			body: "<!doctype html><title>PRF</title><p>PRF test</p>",
			headers: { "content-type": "text/html" },
		}),
	);
	const page = await context.newPage();
	await page.goto("http://localhost:4719/");
	await page.bringToFront();
	let windows = 0;
	context.on("page", () => windows++);

	const created = await actOnPasskeyCard(page, "passkey-approve", () => create(page, "salt-a"));
	expect(created.first).toMatch(/^[0-9a-f]{64}$/);
	expect(await actOnPasskeyCard(page, "passkey-pick", () => get(page, created.id, "salt-a"))).toBe(
		created.first,
	);

	const uv = await actOnPasskeyCard(page, "passkey-pick", () =>
		page.evaluate(async (id) => {
			const rawId = Uint8Array.from(atob(id.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
				c.charCodeAt(0),
			);
			const cred = (await navigator.credentials.get({
				publicKey: {
					rpId: "localhost",
					challenge: new Uint8Array(32),
					allowCredentials: [{ type: "public-key", id: rawId }],
					userVerification: "required",
				},
			})) as PublicKeyCredential;
			const auth = (cred.response as AuthenticatorAssertionResponse).authenticatorData;
			return (new Uint8Array(auth)[32] ?? 0) & 0x04;
		}, created.id),
	);
	expect(uv).toBe(0x04);
	expect(windows).toBe(0);
});

// #187: the sign-in worked, but the confirm window left its route behind, so the toolbar popup
// reopened on a confirm whose request was already gone.
test("the toolbar popup doesn't reopen a finished confirm", async ({ context, extensionId }) => {
	const setup = await context.newPage();
	await createVault(setup, extensionId);
	await setup.evaluate(() =>
		chrome.runtime.sendMessage({
			type: "PASSKEY_PROVIDER_SET_ENABLED",
			payload: { enabled: true },
		}),
	);
	await context.route(/^http:\/\/localhost:4719\//, (route) =>
		route.fulfill({
			body: "<!doctype html><title>PRF</title><p>PRF test</p>",
			headers: { "content-type": "text/html" },
		}),
	);
	const page = await context.newPage();
	await page.goto("http://localhost:4719/");
	await page.bringToFront();
	await verifiedCeremony(context, page, "passkey-approve", () => create(page, "salt"));

	const popup = await context.newPage();
	await openPopup(popup, extensionId);
	await expectUnlocked(popup);
	await expect(popup.getByText("Confirm it's you")).toHaveCount(0);
});

// Confirming with a key detaches Chrome's proxy, which ends the site's request, so the tap has to
// carry over to the site's next try. A virtual authenticator is per tab and can't take a key's PRF
// secret to another one, so the window's browser API stands in for the tap. The detach, the site's
// failure and the retry are real.
test("a key tap in the confirm window lets the site's retry through", async ({
	context,
	extensionId,
}) => {
	const setup = await context.newPage();
	await createVault(setup, extensionId);
	const popup = await context.newPage();
	const { authenticatorId, cdp } = await addVirtualAuthenticator(popup, { hasPrf: true });
	await openPopup(popup, extensionId);
	await expectUnlocked(popup);
	await addTapToUnlockKey(popup, "This device", "Test Touch ID");
	await expect(popup.getByText("Test Touch ID")).toBeVisible();
	const { credentials } = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
	const keyId = credentials[0]?.credentialId ?? "";
	expect(keyId).not.toBe("");

	await setup.evaluate(() =>
		chrome.runtime.sendMessage({
			type: "PASSKEY_PROVIDER_SET_ENABLED",
			payload: { enabled: true },
		}),
	);
	await context.route(/^http:\/\/localhost:4719\//, (route) =>
		route.fulfill({
			body: "<!doctype html><title>PRF</title><p>PRF test</p>",
			headers: { "content-type": "text/html" },
		}),
	);
	const page = await context.newPage();
	await page.goto("http://localhost:4719/");
	await page.bringToFront();
	const created = await verifiedCeremony(context, page, "passkey-approve", () =>
		create(page, "salt"),
	);

	const verifyWindow = context.waitForEvent("page");
	const ended = actOnPasskeyCard(page, "passkey-pick", () =>
		get(page, created.id, "salt").catch((e: Error) => e.message),
	);
	const verify = await verifyWindow;
	const tap = verify.getByRole("button", { name: "Tap to confirm" });
	await expect(tap).toBeVisible();
	await verify.evaluate((id) => {
		const rawId = Uint8Array.from(atob(id), (c) => c.charCodeAt(0)).buffer;
		const first = new Uint8Array(32).buffer;
		navigator.credentials.get = async () =>
			({ rawId, getClientExtensionResults: () => ({ prf: { results: { first } } }) }) as never;
	}, keyId);
	await tap.click();

	expect(await ended).toContain("paused passkey handling");
	await expect(verify.getByText("Sign in again on localhost")).toBeVisible();
	await verify.getByRole("button", { name: "Close" }).click();

	await page.bringToFront();
	const windows = context.pages().length;
	expect(await actOnPasskeyCard(page, "passkey-pick", () => get(page, created.id, "salt"))).toBe(
		created.first,
	);
	expect(context.pages()).toHaveLength(windows);
});
