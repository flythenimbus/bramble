#!/usr/bin/env node
// Record a real site's network traffic into a HAR so e2e specs can replay the
// LIVE app offline (see e2e/extension/README-hars.md). Unlike the stripped DOM
// snapshots in fixtures/sites/, a HAR replay boots the site's real JS, so its
// own click handlers and router run: that is what makes it usable for testing
// capture, where the whole question is what the app does to the DOM on submit.
//
//   node scripts/capture-har.mjs <url> <name> [--consent "Tillåt alla"] [--wait 5000]
//                                [--origins azurestaticapps.net,cdn.example]
//
// Writes e2e/hars/<name>.har.zip. Recording is first-party-only by default
// (--all-origins to include third parties): analytics, consent and captcha
// vendors add weight and non-determinism, and replay aborts them anyway.
// Sites that load their app from another origin (module-federation remotes,
// asset CDNs) need those listed via --origins or the replay boots an empty
// shell. Watch the "visible inputs" count the script prints: zero means the
// app never mounted and something it needs is missing from the recording.

import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const dir = path.dirname(fileURLToPath(import.meta.url));
const HAR_DIR = path.resolve(dir, "../e2e/hars");

function arg(flag, fallback) {
	const i = process.argv.indexOf(flag);
	return i === -1 ? fallback : process.argv[i + 1];
}

const [url, name] = process.argv.slice(2).filter((a) => !a.startsWith("--") && !/^\d+$/.test(a));
if (!url || !name) {
	console.error("usage: capture-har.mjs <url> <name> [--consent <button text>] [--wait <ms>]");
	process.exit(1);
}

const consent = arg("--consent", null);
const settle = Number(arg("--wait", "5000"));
const allOrigins = process.argv.includes("--all-origins");
const origin = new URL(url).hostname.replace(/^www\./, "");
const extra = (arg("--origins", "") || "").split(",").filter(Boolean);
const hosts = [origin, ...extra].map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
// Skipping stylesheets, fonts and images typically halves the recording. Only do
// it once a spec confirms layout isn't load-bearing for what it asserts: our
// rendered/hidden checks read getBoundingClientRect, so a site that hides via a
// stylesheet class rather than an inline style would need its CSS kept.
const skip = (arg("--skip", "") || "").split(",").filter(Boolean);
const skipRe = skip.length ? `(?!.*\\.(${skip.join("|")})(\\?|$))` : "";
const urlFilter = new RegExp(`^${skipRe}https?://[^/]*(${hosts.join("|")})`);

mkdirSync(HAR_DIR, { recursive: true });
const harPath = path.join(HAR_DIR, `${name}.har.zip`);

const browser = await chromium.launch();
const context = await browser.newContext({
	locale: arg("--locale", "en-US"),
	viewport: { width: 1280, height: 900 },
	recordHar: {
		path: harPath,
		// minimal drops timing/sizes/cookies we never replay; attach keeps bodies
		// as zip entries rather than base64 inline, which keeps the file sane.
		mode: "minimal",
		content: "attach",
		...(allOrigins ? {} : { urlFilter }),
	},
});

const page = await context.newPage();
console.log(`recording ${url}`);
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
await page.waitForTimeout(settle);

if (consent) {
	const btn = page.getByText(consent, { exact: false }).first();
	if (await btn.count()) {
		await btn.click().catch(() => {});
		console.log(`clicked consent: ${consent}`);
		await page.waitForTimeout(settle);
	} else {
		console.warn(`consent button not found: ${consent}`);
	}
}

// Idle a little longer so lazily-imported route chunks land in the recording.
await page.waitForTimeout(2000);
const inputs = await page.locator("input:not([type=hidden])").count();
console.log(`captured with ${inputs} visible inputs on screen`);

// The HAR is flushed on context.close().
await context.close();
await browser.close();
console.log(`wrote ${path.relative(process.cwd(), harPath)}`);
