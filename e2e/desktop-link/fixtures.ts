import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type BrowserContext, test as base, chromium, type Page } from "@playwright/test";
import { optionsUrl, popupUrl } from "../extension/helpers";

/**
 * The real desktop app and the real extension, linked on one machine. See e2e/README.md.
 *
 * The desktop app runs from its debug build with HOME and CFFIXED_USER_HOME pointed at a scratch
 * directory holding a throwaway keychain, so its data, socket, native-messaging manifests and
 * keychain items never touch the user's own install. It is driven through the dev-only bridge
 * (clients/desktop/scripts/vite-e2e-bridge.mjs), which the config arms with a per-run token.
 */

const dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(dir, "../..");
const TAURI = path.join(ROOT, "clients/desktop/src-tauri");
const DESKTOP_BIN = path.join(TAURI, "target/debug/bramble-desktop");
const EXTENSION_BUILD = path.join(ROOT, "clients/extension/dist-chromium");
const BRIDGE = "http://localhost:1420/__bramble_e2e";

/** The local relay the config starts. The desktop is pointed at it before its first invite, and
 * the invite carries it to the browser, so nothing here reaches the hosted one. */
export const RELAY_URL = "ws://localhost:7400";
export const DESKTOP_PW = "Desk-9Kq2-Lm7x-Vb3n";
export const BROWSER_PW = "Ext-7Hq9-Pz2m-Wd4k";
/** Already in the desktop's vault when each test starts. */
export const DESKTOP_ENTRY = "GitHub";

// ---- the user's keychain, which nothing here may change ----

function keychainSettings(env: NodeJS.ProcessEnv = process.env): string {
	const run = (...args: string[]) => {
		try {
			return execFileSync("security", args, { env, encoding: "utf8", stdio: "pipe" });
		} catch {
			// What an empty scratch HOME answers: no default keychain at all.
			return `(${args[0]}: none)\n`;
		}
	};
	return run("default-keychain", "-d", "user") + run("list-keychains", "-d", "user");
}

/** A scratch HOME with a throwaway keychain as its default. Refuses before changing anything if
 * the scratch environment would reach the user's own keychain settings. */
function scratchHome(): string {
	// Short and under /tmp: the app's socket lives in here, and a socket path must fit in 104 bytes.
	const home = mkdtempSync("/tmp/bdl-");
	// The app installs a manifest only for browsers whose support directory exists.
	for (const sub of ["Preferences", "Keychains", "Application Support/Chromium"]) {
		mkdirSync(path.join(home, "Library", sub), { recursive: true });
	}
	const env = { ...process.env, HOME: home, CFFIXED_USER_HOME: home };
	const realHome = process.env.HOME ?? "";
	if (realHome && keychainSettings(env).includes(realHome)) {
		throw new Error("security still reads the real keychain settings under the scratch HOME");
	}
	const keychain = path.join(home, "Library/Keychains/scratch.keychain-db");
	const sec = (...args: string[]) => execFileSync("security", args, { env, stdio: "pipe" });
	sec("create-keychain", "-p", "scratch", keychain);
	sec("default-keychain", "-d", "user", "-s", keychain);
	sec("list-keychains", "-d", "user", "-s", keychain);
	sec("unlock-keychain", "-p", "scratch", keychain);
	sec("set-keychain-settings", keychain); // no auto-lock mid-run
	if (!keychainSettings(env).includes(keychain)) {
		throw new Error("the scratch keychain did not become the scratch HOME's default");
	}
	return home;
}

// ---- the desktop app ----

/**
 * The DOM helpers every bridge call runs with, in the desktop window.
 *
 * The window opens behind whatever is in front, and macOS then counts it as hidden: WebKit stops
 * rendering it, so innerText comes back empty while the DOM and its events work as usual. Every
 * helper here therefore reads textContent too, rather than depend on the window being on top.
 */
const PRELUDE = `
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = () => document.body.innerText || document.body.textContent || "";
const visible = (el) => !!(el && el.offsetParent !== null);
const names = (el) => [
	el.getAttribute("aria-label") || "",
	(el.innerText || "").trim(),
	(el.textContent || "").trim(),
];
const find = (re, sel = "button,a,[role=button],[role=radio],label") =>
	[...document.querySelectorAll(sel)].filter(visible).find((el) => names(el).some((n) => re.test(n)));
async function waitFor(fn, ms = 10000) {
	const end = Date.now() + ms;
	while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(100); }
	throw new Error("timed out: " + fn.toString().slice(0, 120));
}
// Raise the vault window, as a person does before using it: a hidden one is throttled, and work
// the screen starts in the background (arming the invite) then lags behind the browser.
async function front() {
	await window.__TAURI_INTERNALS__.invoke("spotlight_open_main");
	await waitFor(() => document.visibilityState === "visible", 3000).catch(() => {});
}
const missing = (what) => () => {
	throw new Error("no " + what + " in the desktop window (" + document.visibilityState + "): " + text().slice(0, 400));
};
async function click(re, sel) {
	(await waitFor(() => find(re, sel)).catch(missing(re))).click();
	await sleep(150);
}
function setValue(el, v) {
	Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value").set.call(el, v);
	el.dispatchEvent(new Event("input", { bubbles: true }));
	el.dispatchEvent(new Event("change", { bubbles: true }));
}
async function fill(selector, v) {
	setValue(await waitFor(() => [...document.querySelectorAll(selector)].find(visible)), v);
}
async function fillLabel(re, v) {
	const label = await waitFor(() => find(re, "label")).catch(missing(re));
	setValue(label.control || label.querySelector("input,textarea"), v);
}
async function fillPasswords(v) {
	const els = await waitFor(() => {
		const f = [...document.querySelectorAll('input[type="password"]')].filter(visible);
		return f.length ? f : null;
	});
	for (const el of els) setValue(el, v);
}
`;

/** Run `code` (an async function body) in the desktop window and return its result. Each call
 * must finish inside the bridge's 30 s. */
export async function desk<T = unknown>(code: string): Promise<T> {
	const res = await fetch(BRIDGE, {
		method: "POST",
		headers: { "x-bramble-e2e": process.env.BRAMBLE_E2E_TOKEN ?? "" },
		body: JSON.stringify({ code: `${PRELUDE}\n${code}` }),
	});
	if (!res.ok) throw new Error(`desktop bridge answered ${res.status}`);
	const answer = (await res.json()) as { ok: boolean; value?: T; error?: string };
	if (!answer.ok) throw new Error(`in the desktop window: ${answer.error}`);
	return answer.value as T;
}

async function waitForDesktop(app: ChildProcess, log: string): Promise<void> {
	const end = Date.now() + 90_000;
	let last = "";
	while (Date.now() < end) {
		if (app.exitCode !== null) throw new Error(`the desktop app exited; see ${log}`);
		const up = await desk("return true").catch((e: unknown) => {
			last = String(e);
			return false;
		});
		if (up) return;
		await new Promise((r) => setTimeout(r, 1000));
	}
	throw new Error(`the desktop window never answered the bridge (${last}); see ${log}`);
}

/** A first vault with one login, synced through the local relay. */
async function setUpDesktopVault(): Promise<void> {
	await desk(`
		await front();
		await waitFor(() => find(/^Create vault$/) || find(/Create your vault/), 20000).catch(() => {
			throw new Error("unexpected first screen: " + text().slice(0, 300));
		});
		const start = find(/Create your vault/);
		if (start) { start.click(); await waitFor(() => find(/^Create vault$/)); }
		await fillPasswords(${JSON.stringify(DESKTOP_PW)});
		await click(/^Create vault$/);
		await click(/I've saved it/);
		await waitFor(() => find(/^Add New$/));
	`);
	await desk(`
		await click(/^Add New$/);
		await click(/^Login/);
		await fill("input[name=name]", ${JSON.stringify(DESKTOP_ENTRY)});
		await fill("input[name=username]", "octocat@example.com");
		await fill('input[type="password"]', "Desk-only-pw-123");
		await click(/^Save Login$/);
		await waitFor(() => /Items \\(1\\)/.test(text()));
	`);
	// After the vault exists: creating it resets the relay (see e2e/sync/fixtures.ts).
	await desk(`
		await click(/^Settings$/);
		await click(/^Sync$/);
		await click(/^Advanced$/);
		await fillLabel(/Nostr relay URL/, ${JSON.stringify(RELAY_URL)});
		await fillLabel(/TURN \\/ ICE servers URL/, "");
	`);
	await desk("await click(/^Go to vault$/);");
}

export interface Desktop {
	home: string;
	/** Browsers the desktop has linked to any of its vaults, from its own pairing record. */
	linkedBrowsers(): number;
}

// ---- the browser ----

/** One timestamped thing an extension context did: a request, or a console line. */
export interface Seen {
	t: number;
	kind: "net" | "log";
	text: string;
	/** Which context: "offscreen.html", "background.js", "options.html", ... */
	from: string;
}

/** Everything the extension's own contexts (worker, offscreen document, pages) send and log,
 * over a raw CDP connection: Playwright does not expose the offscreen document. */
async function watchExtension(port: number, extensionId: string) {
	const seen: Seen[] = [];
	const { webSocketDebuggerUrl } = (await (
		await fetch(`http://127.0.0.1:${port}/json/version`)
	).json()) as { webSocketDebuggerUrl: string };
	const ws = new WebSocket(webSocketDebuggerUrl);
	let id = 0;
	const send = (method: string, params: object = {}, sessionId?: string) =>
		ws.send(JSON.stringify({ id: ++id, method, params, sessionId }));
	const attached = new Set<string>();
	/** The page each CDP session belongs to, by the last part of its URL. */
	const pages = new Map<string, string>();
	const from = (sessionId?: string) => (sessionId && pages.get(sessionId)) || "?";
	ws.onmessage = (m) => {
		const msg = JSON.parse(String(m.data));
		const p = msg.params;
		if (msg.method === "Target.targetCreated" || msg.method === "Target.targetInfoChanged") {
			const t = p.targetInfo;
			if (t.url.includes(extensionId) && !attached.has(t.targetId)) {
				attached.add(t.targetId);
				send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
			}
		} else if (msg.method === "Target.attachedToTarget") {
			pages.set(p.sessionId, new URL(p.targetInfo.url).pathname.replace(/^\//, ""));
			send("Network.enable", {}, p.sessionId);
			send("Runtime.enable", {}, p.sessionId);
			send("Runtime.runIfWaitingForDebugger", {}, p.sessionId);
		} else if (msg.method === "Network.webSocketCreated") {
			seen.push({ t: Date.now(), kind: "net", text: p.url, from: from(msg.sessionId) });
		} else if (msg.method === "Network.requestWillBeSent") {
			const url: string = p.request.url;
			if (!/^(chrome-extension|data|blob):/.test(url)) {
				seen.push({ t: Date.now(), kind: "net", text: url, from: from(msg.sessionId) });
			}
		} else if (msg.method === "Runtime.consoleAPICalled") {
			const line = p.args.map((a: { value?: unknown }) => String(a.value ?? "")).join(" ");
			seen.push({ t: Date.now(), kind: "log", text: line, from: from(msg.sessionId) });
		}
	};
	await new Promise<void>((resolve, reject) => {
		ws.onopen = () => resolve();
		ws.onerror = () => reject(new Error("could not reach the browser over CDP"));
	});
	send("Target.setDiscoverTargets", { discover: true });
	return {
		seen,
		/** The first thing seen of `kind` matching `re`. */
		first: (kind: Seen["kind"], re: RegExp) => seen.find((s) => s.kind === kind && re.test(s.text)),
		/** How many lines of `kind` matching `re` one context produced. */
		count: (kind: Seen["kind"], re: RegExp, page: string) =>
			seen.filter((s) => s.kind === kind && s.from === page && re.test(s.text)).length,
		stop: () => ws.close(),
	};
}

function freePort(): Promise<number> {
	return new Promise((resolve) => {
		const server = createServer();
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as { port: number };
			server.close(() => resolve(port));
		});
	});
}

export interface Browser {
	context: BrowserContext;
	extensionId: string;
	/** The options tab, on the first-run screen. */
	page: Page;
	watch: Awaited<ReturnType<typeof watchExtension>>;
	/** A detached popup, so Settings links in place rather than offering a window. */
	popup(): Promise<Page>;
	/** What the extension holds in storage.local under `key`. */
	stored(key: string): Promise<unknown>;
	/** The storage.local keys starting with `prefix`, sorted. */
	storedKeys(prefix: string): Promise<string[]>;
}

/**
 * A fresh browser profile with the extension, able to reach the scratch desktop app: its
 * NativeMessagingHosts holds the app's manifest, and it runs under the scratch HOME so the proxy
 * it spawns finds the scratch socket. The extension is a copy with nativeMessaging required,
 * since nothing can answer the optional-permission prompt here.
 *
 * `borrowsPipe` is a browser that granted the permission at link time. Its background worker
 * started before the grant and so has no `connectNative` (docs/desktop-link-optional-permission.md,
 * finding 1): everything it says to the app rides a pipe a page lends it. The grant itself cannot
 * be automated (finding 8), so this copy holds the permission from install and takes the binding
 * away from the worker before any of its code runs. Pages keep theirs, as they do after a grant.
 */
async function launchBrowser(
	home: string,
	{ borrowsPipe }: { borrowsPipe: boolean },
): Promise<{ browser: Browser; close(): Promise<void> }> {
	const scratch = mkdtempSync(path.join(tmpdir(), "bramble-desktop-link-browser-"));
	const profile = path.join(scratch, "profile");
	const hosts = path.join(profile, "NativeMessagingHosts");
	mkdirSync(hosts, { recursive: true });
	const manifest = path.join(
		home,
		"Library/Application Support/Chromium/NativeMessagingHosts/app.bramble.desktop.json",
	);
	cpSync(manifest, path.join(hosts, "app.bramble.desktop.json"));

	const extension = path.join(scratch, "extension");
	cpSync(EXTENSION_BUILD, extension, { recursive: true });
	const manifestPath = path.join(extension, "manifest.json");
	const m = JSON.parse(readFileSync(manifestPath, "utf8")) as {
		permissions?: string[];
		optional_permissions?: string[];
		background: { service_worker: string };
	};
	m.permissions = [...new Set([...(m.permissions ?? []), "nativeMessaging"])];
	m.optional_permissions = (m.optional_permissions ?? []).filter((p) => p !== "nativeMessaging");
	if (borrowsPipe) {
		// Imported first, so the binding is gone before the worker's own modules evaluate.
		writeFileSync(
			path.join(extension, "e2e-no-binding.js"),
			`for (const ns of [globalThis.chrome, globalThis.browser]) {
	if (ns?.runtime) Object.defineProperty(ns.runtime, "connectNative", { value: undefined, configurable: true });
}
`,
		);
		writeFileSync(
			path.join(extension, "e2e-background.js"),
			`import "./e2e-no-binding.js";\nimport "./${m.background.service_worker}";\n`,
		);
		m.background.service_worker = "e2e-background.js";
	}
	writeFileSync(manifestPath, JSON.stringify(m));

	const port = await freePort();
	const context = await chromium.launchPersistentContext(profile, {
		channel: "chromium",
		locale: "en-US",
		...(process.env.HEADED ? { headless: false } : {}),
		env: { ...process.env, HOME: home, CFFIXED_USER_HOME: home },
		args: [
			`--disable-extensions-except=${extension}`,
			`--load-extension=${extension}`,
			`--remote-debugging-port=${port}`,
			"--no-sandbox",
		],
	});
	let [sw] = context.serviceWorkers();
	if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 30_000 });
	const extensionId = new URL(sw.url()).host;
	if (
		borrowsPipe &&
		(await sw.evaluate(() => typeof chrome.runtime.connectNative)) !== "undefined"
	) {
		throw new Error("the worker kept its native binding, so nothing here would borrow a pipe");
	}
	const watch = await watchExtension(port, extensionId);
	const page = await context.newPage();
	await page.goto(optionsUrl(extensionId));
	await page.locator("#root").waitFor();

	const browser: Browser = {
		context,
		extensionId,
		page,
		watch,
		popup: async () => {
			const popup = await context.newPage();
			await popup.goto(`${popupUrl(extensionId)}?detached=1`);
			await popup.locator("#root").waitFor();
			return popup;
		},
		stored: async (key) => {
			const worker = context.serviceWorkers().find((w) => w.url().includes(extensionId)) ?? sw;
			return worker.evaluate(async (k) => (await chrome.storage.local.get(k))[k], key);
		},
		storedKeys: async (prefix) => {
			const worker = context.serviceWorkers().find((w) => w.url().includes(extensionId)) ?? sw;
			return worker.evaluate(
				async (p) =>
					Object.keys(await chrome.storage.local.get(null))
						.filter((k) => k.startsWith(p))
						.sort(),
				prefix,
			);
		},
	};
	return {
		browser,
		close: async () => {
			watch.stop();
			await context.close();
			rmSync(scratch, { recursive: true, force: true });
		},
	};
}

export const test = base.extend<
	{ ext: Browser; ext2: Browser; borrowsPipe: boolean },
	{ desktop: Desktop }
>({
	/** A second browser profile beside `ext`, for a desktop vault paired with more than one. */
	ext2: async ({ desktop, borrowsPipe }, use) => {
		const { browser, close } = await launchBrowser(desktop.home, { borrowsPipe });
		await use(browser);
		await close();
	},
	/** See launchBrowser. Off by default: most tests are about the link, not the grant. */
	borrowsPipe: [false, { option: true }],
	desktop: [
		// biome-ignore lint/correctness/noEmptyPattern: Playwright requires the fixtures destructuring param.
		async ({}, use, workerInfo) => {
			if (!existsSync(DESKTOP_BIN)) {
				throw new Error(`no desktop build at ${DESKTOP_BIN}: run pnpm test:e2e:desktop-link`);
			}
			const before = keychainSettings();
			let changed = false;
			const home = scratchHome();
			mkdirSync(workerInfo.project.outputDir, { recursive: true });
			const log = path.join(workerInfo.project.outputDir, "desktop-app.log");
			const out = openSync(log, "w");
			const app = spawn(DESKTOP_BIN, [], {
				cwd: TAURI,
				env: { ...process.env, HOME: home, CFFIXED_USER_HOME: home },
				stdio: ["ignore", out, out],
			});
			try {
				await waitForDesktop(app, log);
				await setUpDesktopVault();
				const pairing = path.join(
					home,
					"Library/Application Support/app.bramble.desktop/pairing.json",
				);
				await use({
					home,
					// Each vault keeps its own list now; `peers` is the frozen app-wide one before them.
					linkedBrowsers: () => {
						if (!existsSync(pairing)) return 0;
						const file = JSON.parse(readFileSync(pairing, "utf8")) as {
							peers?: unknown[];
							vaults?: Record<string, unknown[]>;
						};
						const lists = [file.peers ?? [], ...Object.values(file.vaults ?? {})];
						return lists.reduce((n, list) => n + list.length, 0);
					},
				});
			} finally {
				app.kill();
				await new Promise((r) => (app.exitCode === null ? app.once("exit", r) : r(null)));
				rmSync(home, { recursive: true, force: true });
				changed = keychainSettings() !== before;
				if (changed)
					console.error("[desktop-link] the user's keychain settings changed: check them now");
			}
			if (changed) throw new Error("the user's keychain settings changed during the run");
		},
		{ scope: "worker", timeout: 180_000 },
	],
	ext: async ({ desktop, borrowsPipe }, use, testInfo) => {
		const { browser, close } = await launchBrowser(desktop.home, { borrowsPipe });
		await use(browser);
		// Both sides' own account of what happened, which is most of what a failure here needs.
		// Written to files: the list reporter cuts an inline attachment short.
		if (testInfo.status !== testInfo.expectedStatus) {
			const lines = browser.watch.seen.map(
				(s) => `${new Date(s.t).toISOString()} ${s.from} ${s.kind} ${s.text}`,
			);
			const desktopLog = await desk<string[]>(
				`const bus = await import("/src/sync/bus.ts"); const out = []; bus.onSyncStatus((s) => out.push(s))(); return out;`,
			).catch((e: unknown) => [String(e)]);
			// The app's own log, from the scratch HOME that is deleted with it.
			const appLog = path.join(desktop.home, "Library/Logs/app.bramble.desktop/bramble.log");
			const appLines = existsSync(appLog) ? readFileSync(appLog, "utf8") : "(no log file)";
			for (const [name, body] of [
				["extension.log", lines.join("\n")],
				["desktop-sync.log", desktopLog.join("\n")],
				["desktop-app.log", appLines],
			] as const) {
				const file = testInfo.outputPath(name);
				writeFileSync(file, body);
				await testInfo.attach(name, { path: file, contentType: "text/plain" });
			}
		}
		await close();
	},
});

export const expect = test.expect;
