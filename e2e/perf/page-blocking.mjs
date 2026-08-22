#!/usr/bin/env node
// Measures what the content script costs a real page: main-thread blocking time
// with the extension loaded against the same run without it. This is the harness
// that found issue #59, where autofill detection re-scanned the whole DOM on
// every mutation and 15s of scrolling YouTube went from 1.4s of blocked main
// thread to 6.5s.
//
// Manual, not CI: it needs the network and a real site, and the numbers move
// with the page. Build first:
//
//   pnpm --filter @vault/platform-extension build:chromium
//   node e2e/perf/page-blocking.mjs [url] [--scrolls=30]

import { chromium } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION = path.resolve(here, "../../packages/platform-extension/dist-chromium");
const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith("--")) ?? "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const scrolls = Number(args.find((a) => a.startsWith("--scrolls="))?.split("=")[1] ?? 30);

if (!fs.existsSync(EXTENSION)) {
	console.error(`No build at ${EXTENSION}. Run: pnpm --filter @vault/platform-extension build:chromium`);
	process.exit(1);
}

/** One run: load the page, scroll it, and report what the main thread spent. */
async function run(withExtension) {
	const profile = fs.mkdtempSync(path.join(os.tmpdir(), "bramble-perf-"));
	const launchArgs = ["--autoplay-policy=no-user-gesture-required", "--mute-audio", "--headless=new"];
	if (withExtension) {
		launchArgs.push(`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`);
	}
	const context = await chromium.launchPersistentContext(profile, {
		headless: false, // --headless=new above; extensions need a persistent context
		args: launchArgs,
		viewport: { width: 1440, height: 900 },
	});
	try {
		const page = await context.newPage();
		await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 });
		await page.waitForTimeout(8000);
		await page.evaluate(() => {
			const video = document.querySelector("video");
			if (video) {
				video.muted = true;
				video.play().catch(() => {});
			}
		});
		return await page.evaluate(async (steps) => {
			const tasks = [];
			const observer = new PerformanceObserver((list) => {
				for (const entry of list.getEntries()) tasks.push(entry.duration);
			});
			observer.observe({ entryTypes: ["longtask"] });
			const started = performance.now();
			for (let i = 0; i < steps; i += 1) {
				window.scrollBy(0, 400);
				await new Promise((resolve) => setTimeout(resolve, 500));
			}
			observer.disconnect();
			return {
				seconds: +((performance.now() - started) / 1000).toFixed(1),
				longTasks: tasks.length,
				blockedMs: Math.round(tasks.reduce((a, b) => a + b, 0)),
				worstTaskMs: Math.round(Math.max(0, ...tasks)),
				elements: document.querySelectorAll("*").length,
			};
		}, scrolls);
	} finally {
		await context.close();
		fs.rmSync(profile, { recursive: true, force: true });
	}
}

const off = await run(false);
const on = await run(true);
const row = (name, r) =>
	`${name.padEnd(10)} ${String(r.blockedMs).padStart(7)}ms blocked  ${String(r.worstTaskMs).padStart(6)}ms worst  ${String(r.longTasks).padStart(3)} long tasks  ${r.elements} elements  ${r.seconds}s wall`;
console.log(`\n${url}\n`);
console.log(row("baseline", off));
console.log(row("extension", on));
console.log(`\nextension overhead: ${on.blockedMs - off.blockedMs}ms blocked\n`);
