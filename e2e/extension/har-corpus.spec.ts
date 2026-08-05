import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures";

// Smoke test for the recorded corpus: every HAR must still boot its real app
// offline and render the fields we captured it for. This is what stops a
// recording from silently rotting into an empty shell, which is the failure the
// capture script's "0 visible inputs" warning catches at record time.
// Detection correctness lives in the jsdom fixtures; this asserts the HAR is
// usable at all. See e2e/hars/README.md.

const HARS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../hars");

interface Target {
	har: string;
	url: string;
	/** Selectors that must be present and visible once the app has booted. */
	expect: string[];
	shape: string;
}

const CORPUS: Target[] = [
	{
		har: "hackernews-login",
		url: "https://news.ycombinator.com/login",
		expect: ['input[name="acct"]', 'input[name="pw"]'],
		shape: "no autocomplete attributes anywhere, two identical forms on one page",
	},
	{
		har: "yahoo-login",
		url: "https://login.yahoo.com/",
		expect: ['input[name="username"]'],
		shape: "identifier-first with no autocomplete token",
	},
	{
		har: "bol-login",
		url: "https://www.bol.com/nl/rnwy/account/inloggen",
		expect: ['input[name="j_username"]', 'input[name="j_password"]'],
		shape: "Dutch, Spring Security field names",
	},
	{
		har: "ebay-login",
		url: "https://signin.ebay.com/signin",
		expect: ['input[name="userid"]'],
		shape: "identifier-first behind several iframes",
	},
	{
		har: "skanetrafiken-login",
		url: "https://www.skanetrafiken.se/mitt-konto/",
		expect: ["#email", "#password"],
		shape: "formless SPA, type=button submit, federated remote origin",
	},
];

for (const target of CORPUS) {
	test(`${target.har} replays offline (${target.shape})`, async ({ context }) => {
		const page = await context.newPage();
		// notFound: "abort" keeps this hermetic. Anything not in the recording
		// (analytics, fonts, captcha vendors) fails rather than reaching the network.
		await context.routeFromHAR(path.join(HARS, `${target.har}.har.zip`), { notFound: "abort" });
		await page.goto(target.url, { waitUntil: "domcontentloaded" });

		for (const selector of target.expect) {
			await expect(page.locator(selector).first()).toBeVisible({ timeout: 15_000 });
		}
	});
}
