// Edits between the extension and the iOS app in a simulator, since peers send only what changed
// (docs/sync-rebroadcast.md). The iOS app is the one place sync runs on the native WebRTC shim
// (webrtc-rs), so this is what checks heartbeats and change-only sends on it.
//
// Playwright drives the extension; the app's WKWebView is driven over WebKit's inspector protocol
// through ios_webkit_debug_proxy, which Playwright can't speak. Pairs over the HOSTED relay: App
// Transport Security refuses cleartext to a local one. Needs a Debug build installed and launched
// on a booted simulator, and the proxy serving its pages (packages/platform-mobile/docs/development.md):
//
//   ios_webkit_debug_proxy -s unix:<webinspectord_sim.socket> -c null:9321,:9322-9420 --no-frontend
//   BRAMBLE_EXTENSION=<dist-chromium> IOS_INSPECT_PORT=9322 node e2e/ios/sync-on-simulator.mjs

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";

const PW = "Zx9-mQ2-vLp7-wK4-tR8";
const INSPECT = `http://localhost:${process.env.IOS_INSPECT_PORT ?? 9222}/json`;
const EXTENSION = process.env.BRAMBLE_EXTENSION;
if (!EXTENSION) throw new Error("set BRAMBLE_EXTENSION to a dist-chromium");
const WITHIN_MS = 15_000;
const log = (m) => console.log(`[ios] ${m}`);

// --- the app, over WebKit's inspector protocol ---

async function connectApp() {
	const pages = await (await fetch(INSPECT)).json();
	const page = pages.find((p) => p.webSocketDebuggerUrl);
	if (!page) throw new Error(`no inspectable page: ${JSON.stringify(pages)}`);
	const ws = new WebSocket(page.webSocketDebuggerUrl);
	const pending = new Map();
	let targetId = null;
	let outer = 0;
	let inner = 0;
	ws.onmessage = (ev) => {
		const m = JSON.parse(ev.data);
		if (m.method === "Target.targetCreated" && m.params.targetInfo.type === "page") {
			targetId = m.params.targetInfo.targetId;
		}
		if (m.method === "Target.dispatchMessageFromTarget") {
			const r = JSON.parse(m.params.message);
			pending.get(r.id)?.(r);
			pending.delete(r.id);
		}
	};
	await new Promise((resolve, reject) => {
		ws.onopen = resolve;
		ws.onerror = reject;
	});
	for (let i = 0; i < 50 && !targetId; i++) await new Promise((r) => setTimeout(r, 100));
	if (!targetId) throw new Error("the WebView announced no page target");
	const evaluate = (expression) =>
		new Promise((resolve, reject) => {
			const id = ++inner;
			pending.set(id, (r) =>
				r.error || r.result?.wasThrown
					? reject(new Error(JSON.stringify(r.error ?? r.result.result)))
					: resolve(r.result?.result?.value),
			);
			ws.send(
				JSON.stringify({
					id: ++outer,
					method: "Target.sendMessageToTarget",
					params: {
						targetId,
						message: JSON.stringify({
							id,
							method: "Runtime.evaluate",
							params: { expression, returnByValue: true },
						}),
					},
				}),
			);
		});
	// DOM helpers inside the page: click by visible text or accessible name, fill by label or
	// placeholder through React's own value setter, read the page's text.
	await evaluate(`window.__t = {
		find(re) {
			const rx = new RegExp(re, "i");
			return [...document.querySelectorAll("button, a, [role=button]")].find(
				(b) => rx.test((b.getAttribute("aria-label") || b.textContent || "").trim()) && b.offsetParent,
			);
		},
		has(re) { return Boolean(this.find(re)); },
		click(re) { const b = this.find(re); if (!b) return false; b.click(); return true; },
		fill(re, value) {
			const rx = new RegExp(re, "i");
			let input = [...document.querySelectorAll("input, textarea")].find(
				(i) => rx.test(i.getAttribute("placeholder") || "") || rx.test(i.getAttribute("aria-label") || ""),
			);
			if (!input) {
				const label = [...document.querySelectorAll("label")].find((l) => rx.test(l.textContent || ""));
				input = label && (label.control || label.querySelector("input, textarea"));
			}
			if (!input) return false;
			const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
			Object.getOwnPropertyDescriptor(proto.prototype, "value").set.call(input, value);
			input.dispatchEvent(new Event("input", { bubbles: true }));
			return true;
		},
		text() { return document.body.innerText; },
	}; true`);
	const call = (fn, ...args) =>
		evaluate(`window.__t.${fn}(${args.map((a) => JSON.stringify(a)).join(",")})`);
	const until = async (what, check, timeoutMs = 60_000) => {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (await check()) return;
			await new Promise((r) => setTimeout(r, 250));
		}
		throw new Error(`timed out waiting for ${what}; the app shows: ${(await call("text")).slice(0, 400)}`);
	};
	const clickWhenThere = async (re, timeoutMs) => until(`a button /${re}/`, () => call("click", re), timeoutMs);
	return { call, until, clickWhenThere, close: () => ws.close() };
}

// --- the extension ---

async function launchExtension() {
	const profileDir = mkdtempSync(path.join(tmpdir(), "bramble-ios-"));
	const context = await chromium.launchPersistentContext(profileDir, {
		channel: "chromium",
		locale: "en-US",
		args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
	});
	let [sw] = context.serviceWorkers();
	if (!sw) sw = await context.waitForEvent("serviceworker");
	const id = new URL(sw.url()).host;
	return { context, sw, id, profileDir };
}

const addLoginInPopup = async (popup, name) => {
	await popup.getByRole("button", { name: /Add New/i }).click();
	await popup.getByRole("button", { name: /^Login/ }).first().click();
	await popup.getByLabel(/^Name$/).fill(name);
	await popup.getByLabel(/Username or email/i).fill("octocat@example.com");
	await popup.getByLabel(/^Password$/).first().fill("hunter2-c0rrect-h0rse");
	await popup.getByRole("button", { name: /Save Login/i }).click();
	await popup.getByText(name).waitFor();
};

const ext = await launchExtension();
const syncLog = [];
ext.sw.on("console", (m) => syncLog.push(`${Date.now()} ${m.text()}`));
const app = await connectApp();
try {
	// --- a vault on the extension, invited over the hosted relay ---
	const setup = await ext.context.newPage();
	await setup.goto(`chrome-extension://${ext.id}/options.html`);
	const pw = setup.locator('input[type="password"]');
	await pw.nth(0).fill(PW);
	await pw.nth(1).fill(PW);
	await setup.getByRole("button", { name: "Create vault" }).click();
	await setup.getByRole("button", { name: /I've saved it/i }).click();
	const popup = await ext.context.newPage();
	await popup.goto(`chrome-extension://${ext.id}/popup.html?detached=1`);
	await popup.getByRole("button", { name: /Add New/i }).waitFor();
	await setup.goto(`chrome-extension://${ext.id}/popup.html`);
	await setup.getByRole("button", { name: "Settings" }).click();
	await setup.getByRole("button", { name: "Sync", exact: true }).click();
	await setup.getByRole("button", { name: /^Add a device$/i }).last().click();
	await setup.locator('input[type="password"]').first().fill(PW);
	await setup.getByRole("button", { name: "Continue", exact: true }).click();
	const code = await setup.locator("input[readonly]").inputValue();
	log("invite ready");

	// --- the app joins ---
	if (await app.call("has", "Create your vault")) await app.call("click", "Create your vault");
	await app.clickWhenThere("^Join a device");
	if (await app.call("has", "Paste code instead")) await app.call("click", "Paste code instead");
	await app.until("the code field", () => app.call("fill", "Paste the code from your other device", code));
	await app.until("the password field", () => app.call("fill", "Master password", PW));
	await app.clickWhenThere("^Join vault");
	await setup.getByText(/Is this your device\?/i).waitFor({ timeout: 120_000 });
	await setup.getByRole("button", { name: /They match, approve/i }).click();
	await app.until("the joined vault", () => app.call("has", "^Lock vault"), 120_000);
	log("joined");
	await popup.waitForTimeout(15_000);

	const browserToApp = async (label) => {
		const name = `${label} ${Date.now().toString(36)}`;
		await addLoginInPopup(popup, name);
		const t = Date.now();
		await app.until(name, async () => (await app.call("text")).includes(name), WITHIN_MS);
		log(`${label}: ${Date.now() - t} ms`);
	};
	const appToBrowser = async (label) => {
		const name = `${label} ${Date.now().toString(36)}`;
		await app.clickWhenThere("Add New");
		await app.clickWhenThere("^Login");
		await app.until("the name field", () => app.call("fill", "^Name$", name));
		await app.call("fill", "Username or email", "octocat@example.com");
		await app.call("fill", "^Password$", "hunter2-c0rrect-h0rse");
		await app.clickWhenThere("Save Login");
		await app.until(`${name} on the app`, async () => (await app.call("text")).includes(name));
		const t = Date.now();
		await popup.getByText(name).waitFor({ timeout: WITHIN_MS });
		log(`${label}: ${Date.now() - t} ms`);
	};

	await browserToApp("browser to iPhone");
	await appToBrowser("iPhone to browser");
	// A quiet minute: heartbeats alone have to keep the native-WebRTC peer.
	const quietFrom = Date.now();
	await popup.waitForTimeout(60_000);
	const drops = syncLog.filter(
		(l) => Number(l.split(" ")[0]) >= quietFrom && /idle — dropping|idle, dropping|channel closed/.test(l),
	);
	log(`peer drops during the quiet minute: ${drops.length}${drops.length ? `: ${drops.join(" | ")}` : ""}`);
	await browserToApp("browser to iPhone, after a quiet minute");
	await appToBrowser("iPhone to browser, after a quiet minute");
	log(drops.length === 0 ? "PASS" : "FAIL: the peer dropped while idle");
	if (drops.length) process.exitCode = 1;
} catch (e) {
	log(`FAIL: ${e.message}`);
	process.exitCode = 1;
} finally {
	app.close();
	await ext.context.close();
	rmSync(ext.profileDir, { recursive: true, force: true });
}
