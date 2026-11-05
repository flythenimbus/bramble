#!/usr/bin/env node
// Open the built Chromium extension in a fresh browser profile, deleted when the browser closes.
//
//   pnpm run:chromium
//
// The Firefox counterpart is `pnpm run:firefox` (web-ext run), which does the same for
// dist-firefox. This one uses Playwright's Chromium, already installed for the e2e suites, which
// loads an unpacked build from the command line.
//
// A profile outside the browser's own directory reads native-messaging hosts from inside itself
// rather than from the user's, so the desktop app's manifest is copied in. Without it the extension
// cannot reach the desktop app. The app writes that manifest whenever it starts, pointing at its
// own proxy, so this links to whichever desktop app ran last.

import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSION = join(ROOT, "clients/extension/dist-chromium");
const HOST = "app.bramble.desktop.json";

const fail = (message: string): never => {
	console.error(message);
	process.exit(1);
};

if (!existsSync(join(EXTENSION, "manifest.json"))) {
	fail("not built yet: pnpm --filter @vault/platform-extension build:chromium");
}
const browserBin = chromium.executablePath();
if (!existsSync(browserBin)) fail("no Chromium: pnpm exec playwright install chromium");

/** Where the desktop app writes its manifest for the Chromium-family browsers it finds. Any one
 * will do: they name the same proxy. Windows keeps them in the registry, which a fresh profile
 * reads as it is, so there is nothing to copy there. */
const HOST_DIRS: Partial<Record<NodeJS.Platform, string[]>> = {
	darwin: [
		"Library/Application Support/Chromium",
		"Library/Application Support/Google/Chrome",
		"Library/Application Support/BraveSoftware/Brave-Browser",
	],
	linux: [".config/chromium", ".config/google-chrome", ".config/BraveSoftware/Brave-Browser"],
};

const profile = mkdtempSync(join(tmpdir(), "bramble-chromium-"));
const manifest = (HOST_DIRS[process.platform] ?? [])
	.map((dir) => join(homedir(), dir, "NativeMessagingHosts", HOST))
	.find(existsSync);
if (manifest) {
	mkdirSync(join(profile, "NativeMessagingHosts"));
	copyFileSync(manifest, join(profile, "NativeMessagingHosts", HOST));
	console.log(`desktop app link: ${manifest}`);
} else if (process.platform !== "win32") {
	console.log("no desktop app manifest yet: start the desktop app once to link with it");
}

console.log(`profile ${profile} (deleted on close)\n`);
const browser = spawn(
	browserBin,
	[
		`--user-data-dir=${profile}`,
		`--disable-extensions-except=${EXTENSION}`,
		`--load-extension=${EXTENSION}`,
		"--no-first-run",
		"--no-default-browser-check",
	],
	{ stdio: "inherit" },
);

// Ctrl-C closes the browser first, so the profile is not deleted under a running one.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => browser.kill(signal));
}
browser.on("exit", (code) => {
	rmSync(profile, { recursive: true, force: true });
	process.exit(code ?? 0);
});
