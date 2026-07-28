import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
	type Browser,
	type BrowserContext,
	test as base,
	chromium,
	type Page,
} from "@playwright/test";

/**
 * Drives the REAL app on a REAL Android device, over the WebView's devtools socket.
 *
 * Capacitor turns on WebView remote debugging for debuggable builds, so the running app exposes
 * an abstract unix socket (`webview_devtools_remote_<pid>`). Forward that to a TCP port and
 * Playwright can attach with connectOverCDP, giving the same API as the desktop e2e — except the
 * code underneath is the shipped one: the uniffi Rust core, Capacitor's native Filesystem and
 * Preferences, the real `.bak` rotation. That's the layer a browser-hosted mobile app can't reach.
 *
 * Limits worth knowing: CDP only sees the WebView DOM. Native UI — the Android autofill sheet,
 * biometric prompts, the system file picker — is invisible here and needs Espresso or Maestro.
 */

const PORT = Number(process.env.ANDROID_CDP_PORT ?? 9222);
const APP_ID = process.env.ANDROID_APP_ID ?? "app.bramble.mobile";

function adbPath(): string {
	const candidates = [
		process.env.ADB,
		process.env.ANDROID_HOME && path.join(process.env.ANDROID_HOME, "platform-tools/adb"),
		path.join(homedir(), "Library/Android/sdk/platform-tools/adb"),
		"/usr/local/bin/adb",
	].filter((c): c is string => Boolean(c));
	const found = candidates.find((c) => existsSync(c));
	if (found) return found;
	try {
		return execFileSync("/bin/sh", ["-c", "command -v adb"], { encoding: "utf8" }).trim();
	} catch {
		throw new Error("adb not found — set ADB or ANDROID_HOME");
	}
}

const adb = (args: string[]): string => execFileSync(adbPath(), args, { encoding: "utf8" }).trim();

function requireDevice(): void {
	const lines = adb(["devices"]).split("\n").slice(1).filter(Boolean);
	const ready = lines.filter((l) => l.endsWith("\tdevice"));
	if (ready.length === 0) throw new Error("no Android device attached (check `adb devices`)");
	if (ready.length > 1) {
		throw new Error("several devices attached; set ANDROID_SERIAL to pick one");
	}
}

/** Pid of the running app, launching it first if needed. */
function appPid(): string {
	const read = () => adb(["shell", "pidof", APP_ID]).trim();
	let pid = "";
	try {
		pid = read();
	} catch {
		pid = "";
	}
	if (pid) return pid;
	adb(["shell", "monkey", "-p", APP_ID, "-c", "android.intent.category.LAUNCHER", "1"]);
	for (let i = 0; i < 20; i++) {
		try {
			pid = read();
		} catch {
			pid = "";
		}
		if (pid) return pid;
		execFileSync("/bin/sh", ["-c", "sleep 0.5"]);
	}
	throw new Error(`${APP_ID} did not start (is it installed and debuggable?)`);
}

/** Forward the app's devtools socket to a local TCP port; returns a cleanup. */
function forwardDevtools(pid: string): () => void {
	adb(["forward", `tcp:${PORT}`, `localabstract:webview_devtools_remote_${pid}`]);
	return () => {
		try {
			adb(["forward", "--remove", `tcp:${PORT}`]);
		} catch {
			// the device may already be gone; nothing to clean up
		}
	};
}

/**
 * Route the DEVICE's `localhost:<port>` back to this machine's, so the phone can reach a relay
 * running here. It also means a pairing code containing `ws://localhost:7400` is valid verbatim on
 * both peers — no rewriting, and the code the inviter really produced is the one the joiner uses.
 */
export function adbReverse(port: number): () => void {
	adb(["reverse", `tcp:${port}`, `tcp:${port}`]);
	return () => {
		try {
			adb(["reverse", "--remove", `tcp:${port}`]);
		} catch {
			// device already gone; nothing to undo
		}
	};
}

export const test = base.extend<{ browser: Browser; context: BrowserContext; page: Page }>({
	// biome-ignore lint/correctness/noEmptyPattern: Playwright requires the fixtures destructuring param.
	browser: async ({}, use) => {
		requireDevice();
		const stopForward = forwardDevtools(appPid());
		const browser = await chromium.connectOverCDP(`http://localhost:${PORT}`);
		await use(browser);
		// Disconnects from the WebView. Deliberately does NOT stop the app: this is the user's
		// device, and a test run should leave it as it found it.
		await browser.close();
		stopForward();
	},
	context: async ({ browser }, use) => {
		const ctx = browser.contexts()[0];
		if (!ctx) throw new Error("no browser context on the device WebView");
		await use(ctx);
	},
	page: async ({ context }, use) => {
		const page = context.pages()[0];
		if (!page) throw new Error("the app's WebView has no page");
		await use(page);
	},
});

export const expect = test.expect;
