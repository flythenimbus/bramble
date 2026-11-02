import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { actOnPasskeyCard, createVault } from "./helpers";

// The proxy request carries no tab, and the provider used to take the origin from whichever tab
// was in front: a background page under the same rpId got an assertion signed with the focused
// page's origin after one approval there. Two localhost ports stand in for two subdomains of one
// rpId. Only a real Chrome shows that it stamps the requester and that we refuse a background one.

const VICTIM = "http://localhost:4719/";
const OTHER = "http://localhost:4720/";

function create(page: Page) {
	return page.evaluate(async () => {
		const cred = (await navigator.credentials.create({
			publicKey: {
				rp: { id: "localhost", name: "Origin test" },
				user: { id: new Uint8Array([7]), name: "ada", displayName: "Ada" },
				challenge: new Uint8Array(32),
				pubKeyCredParams: [{ type: "public-key", alg: -7 }],
			},
		})) as PublicKeyCredential;
		return cred.id;
	});
}

/** A sign-in from `page`: the origin its assertion was signed for, or the error it got. */
function signIn(page: Page) {
	return page.evaluate(async () => {
		try {
			const cred = (await navigator.credentials.get({
				publicKey: { rpId: "localhost", challenge: new Uint8Array(32) },
			})) as PublicKeyCredential;
			const response = cred.response as AuthenticatorAssertionResponse;
			return { origin: JSON.parse(new TextDecoder().decode(response.clientDataJSON)).origin };
		} catch (e) {
			return { error: (e as Error).name };
		}
	});
}

test("a background page under the same rpId is refused, not signed as the focused page", async ({
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
	await context.route(/^http:\/\/localhost:47(19|20)\//, (route) =>
		route.fulfill({
			body: "<!doctype html><title>t</title>",
			headers: { "content-type": "text/html" },
		}),
	);

	const victim = await context.newPage();
	await victim.goto(VICTIM);
	const other = await context.newPage();
	await other.goto(OTHER);

	await victim.bringToFront();
	await actOnPasskeyCard(victim, "passkey-approve", () => create(victim));

	// The background page asks while the victim is in front: refused, and no card on the victim.
	expect(await signIn(other)).toEqual({ error: "NotAllowedError" });
	await expect(victim.locator("#bramble-corner-prompt")).toHaveCount(0);

	// In front, the same page is served, and signed as itself.
	await other.bringToFront();
	expect(await actOnPasskeyCard(other, "passkey-pick", () => signIn(other))).toEqual({
		origin: "http://localhost:4720",
	});
});
