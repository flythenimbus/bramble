import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { clickCornerAction, createVault } from "./helpers";

// PRF through Chrome's real webAuthenticationProxy: the request Chrome hands us carries the site's
// inputs, and Chrome accepts what we answer (enabled on create, 32-byte results) and passes it to
// the page. Only a real browser proves both halves. See docs/passkey-prf.md.

const PROMPT = "#bramble-corner-prompt";

/**
 * Start a ceremony in the page, act on its corner card, and return the page's result. A save card
 * confirms with "passkey-approve"; a sign-in card lists accounts and acts on "passkey-pick".
 */
async function approved<T>(
	page: Page,
	action: "passkey-approve" | "passkey-pick",
	run: () => Promise<T>,
): Promise<T> {
	const result = run();
	await expect
		.poll(
			async () => {
				try {
					await clickCornerAction(page, action);
					return true;
				} catch {
					return false;
				}
			},
			{ timeout: 15_000 },
		)
		.toBe(true);
	const value = await result;
	// The next ceremony's card must not be mistaken for this one.
	await expect(page.locator(PROMPT)).toHaveCount(0, { timeout: 10_000 });
	return value;
}

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

	const created = await approved(page, "passkey-approve", () => create(page, "salt-a"));
	expect(created.enabled).toBe(true);
	expect(created.first).toMatch(/^[0-9a-f]{64}$/);

	// Same passkey, same input: the same key at sign-in as at registration.
	const signIn = (salt: string, ownSalt?: string) =>
		approved(page, "passkey-pick", () => get(page, created.id, salt, ownSalt));
	expect(await signIn("salt-a")).toBe(created.first);

	const saltB = await signIn("salt-b");
	expect(saltB).toMatch(/^[0-9a-f]{64}$/);
	expect(saltB).not.toBe(created.first);

	// The credential's own evalByCredential entry wins over eval.
	expect(await signIn("salt-a", "salt-b")).toBe(saltB);
});
