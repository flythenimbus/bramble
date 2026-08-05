#!/usr/bin/env node
// Record a real site's network traffic into a HAR so e2e specs can replay the
// LIVE app offline (see e2e/extension/README-hars.md). Unlike the stripped DOM
// snapshots in fixtures/sites/, a HAR replay boots the site's real JS, so its
// own click handlers and router run: that is what makes it usable for testing
// capture, where the whole question is what the app does to the DOM on submit.
//
//   node scripts/capture-har.mjs <url> <name> [--consent "Tillåt alla"] [--wait 5000]
//                                [--origins azurestaticapps.net,cdn.example] [--manual]
//
// Runs HEADED. Recording is a human operation, not a CI step, and a visible
// window is both what gets past the bot detection on some sites and what lets
// you drive a flow by hand. Pass --headless for an unattended re-record.
//
// --manual holds the browser open until you press Enter in this terminal, so you
// can dismiss a consent wall, log in with a throwaway account, and walk to a 2FA
// screen before the HAR is written. That is the only way to record the flows the
// automated path cannot reach: segmented code widgets, password-change forms,
// and any successful login.
//
// Writes e2e/hars/<name>.har.zip. Recording is first-party-only by default
// (--all-origins to include third parties): analytics, consent and captcha
// vendors add weight and non-determinism, and replay aborts them anyway.
// Sites that load their app from another origin (module-federation remotes,
// asset CDNs) need those listed via --origins or the replay boots an empty
// shell. Watch the "visible inputs" count the script prints: zero means the
// app never mounted and something it needs is missing from the recording.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const dir = path.dirname(fileURLToPath(import.meta.url));
const HAR_DIR = path.resolve(dir, "../e2e/hars");

// Flags that consume the next argv entry. Positional parsing has to know about
// them, or a value like `--consent "Tillåt alla"` is read as the fixture name.
const VALUE_FLAGS = new Set([
	"--consent",
	"--wait",
	"--locale",
	"--origins",
	"--skip",
	"--channel",
]);

function arg(flag, fallback) {
	const i = process.argv.indexOf(flag);
	return i === -1 ? fallback : process.argv[i + 1];
}

const argv = process.argv.slice(2);
const positional = [];
for (let i = 0; i < argv.length; i++) {
	if (VALUE_FLAGS.has(argv[i])) i++;
	else if (!argv[i].startsWith("--")) positional.push(argv[i]);
}
const [url, name] = positional;
if (!url || !name) {
	console.error(
		"usage: capture-har.mjs <url> <name> [--consent <text>] [--wait <ms>] [--locale <tag>]\n" +
			"                          [--origins <a,b>] [--skip <ext,ext>] [--all-origins]\n" +
			"                          [--manual] [--headless] [--channel chrome]",
	);
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

// Playwright's default UA announces "HeadlessChrome", which makes some sites
// serve a different page or rate-limit outright (news.ycombinator.com 429s and
// records zero inputs). A recording of the wrong page is worse than no
// recording, so present as ordinary desktop Chrome, which is what this is.
const UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// recordHar's `mode: "minimal"` drops the HAR's `cookies` arrays but NOT the
// Cookie / Set-Cookie request and response headers, so an authenticated
// recording carries a live session into a committed file. Replay matches on URL
// and never sends these, so stripping them costs nothing and is done every time
// rather than behind a flag: the one recording someone forgets to scrub is the
// one that matters. Body content is NOT scrubbed and cannot safely be — record
// with a throwaway account.
const CREDENTIAL_HEADERS = new Set([
	"cookie",
	"set-cookie",
	"authorization",
	"proxy-authorization",
	"www-authenticate",
]);

/** Strip credential headers from a written .har.zip in place; returns how many went. */
function scrubHeaders(rel) {
	// Absolute: the rezip runs with cwd set to the temp dir, so a relative path
	// would be resolved against it and the original would already be gone.
	const zipPath = path.resolve(rel);
	const dir = mkdtempSync(path.join(tmpdir(), "har-scrub-"));
	try {
		execFileSync("unzip", ["-q", zipPath, "-d", dir]);
		const harFile = path.join(dir, "har.har");
		const har = JSON.parse(readFileSync(harFile, "utf8"));
		let removed = 0;
		for (const entry of har.log?.entries ?? []) {
			for (const side of [entry.request, entry.response]) {
				if (!side) continue;
				if (Array.isArray(side.headers)) {
					const before = side.headers.length;
					side.headers = side.headers.filter((h) => !CREDENTIAL_HEADERS.has(h.name.toLowerCase()));
					removed += before - side.headers.length;
				}
				if (Array.isArray(side.cookies)) side.cookies = [];
			}
		}
		writeFileSync(harFile, JSON.stringify(har));
		rmSync(zipPath);
		execFileSync("zip", ["-rq", zipPath, "."], { cwd: dir });
		return removed;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const manual = process.argv.includes("--manual");
// Headed by default. --manual forces it: there is nothing to drive otherwise.
const headless = process.argv.includes("--headless") && !manual;

const browser = await chromium.launch({
	headless,
	channel: arg("--channel", undefined),
	// Playwright sets navigator.webdriver, which some bot checks read directly.
	args: ["--disable-blink-features=AutomationControlled"],
});
const context = await browser.newContext({
	locale: arg("--locale", "en-US"),
	userAgent: UA,
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

// Every origin the page asked for that the filter dropped, so a recording that
// comes back inert tells you what to put in --origins instead of guessing. Only
// script/xhr/fetch/document count: fonts and images never matter for replay.
const dropped = new Map();
context.on("request", (r) => {
	if (allOrigins || urlFilter.test(r.url())) return;
	if (!["script", "xhr", "fetch", "document"].includes(r.resourceType())) return;
	const host = new URL(r.url()).hostname;
	dropped.set(host, (dropped.get(host) ?? 0) + 1);
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

if (manual) {
	console.log(
		"\n  Drive the browser now. Everything you do is recorded.\n" +
			"  Use a throwaway account: whatever the session returns ends up in the HAR.\n" +
			"  Press Enter here when you're done.\n",
	);
	process.stdin.resume();
	await new Promise((resolve) => process.stdin.once("data", resolve));
	process.stdin.pause();
}

// Idle a little longer so lazily-imported route chunks land in the recording.
await page.waitForTimeout(2000);
// Report on whatever page the operator ended on, not the one we opened.
const last = context.pages().at(-1) ?? page;
const inputs = await last.locator("input:not([type=hidden])").count().catch(() => 0);
console.log(`captured with ${inputs} visible inputs on screen`);
console.log(`final url: ${last.url()}`);

const top = [...dropped.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
if (top.length > 0) {
	const verdict = inputs === 0 ? "the app did not mount, so one of these is needed" : "not recorded";
	console.log(`\ndropped script/xhr origins (${verdict}):`);
	for (const [host, n] of top) console.log(`  ${String(n).padStart(4)}  ${host}`);
	console.log(`  re-run with --origins ${top[0][0]}  if the replay comes back empty`);
}

// The HAR is flushed on context.close().
await context.close();
await browser.close();

console.log(`scrubbed ${scrubHeaders(harPath)} credential headers`);
console.log(`wrote ${path.relative(process.cwd(), harPath)}`);
