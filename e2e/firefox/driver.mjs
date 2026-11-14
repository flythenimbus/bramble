// Drives a stock Firefox with the built add-on installed, over WebDriver BiDi. Playwright cannot
// load a Firefox add-on and its own Firefox is a patched build; web-ext can install one but not
// type or click. Checked on Firefox 160.
//
// Three things here are not obvious:
// - BiDi refuses to navigate to moz-extension://, so the add-on's own pages are opened by one of
//   its web-accessible frames (openExtensionPage). Driving them needs
//   MOZ_REMOTE_ALLOW_SYSTEM_ACCESS.
// - The add-on's uuid is pinned by a pref, so those pages have a known origin.
// - A closed shadow root is reachable: BiDi serialises it when asked (inShadow).

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION =
	process.env.BRAMBLE_EXTENSION ?? path.resolve(here, "../../clients/extension/dist-firefox");
const UUID = "0f0e0d0c-1a2b-4c3d-8e9f-aabbccddeeff";
export const EXT_ORIGIN = `moz-extension://${UUID}`;
/** A strong master password that clears the weak-password gate, as in extension/helpers.ts. */
const STRONG_PW = "Zx9-mQ2-vLp7-wK4-tR8";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll `fn` until it returns something truthy. */
export async function waitFor(fn, what, timeout = 15_000) {
	const start = Date.now();
	for (;;) {
		const value = await fn().catch(() => undefined);
		if (value) return value;
		if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${what}`);
		await sleep(150);
	}
}

/** Serve `routes` (path -> { body, headers }, "*" for the rest) on a free local port. */
export async function serve(routes) {
	const server = createServer((req, res) => {
		const url = new URL(req.url, "http://localhost");
		const route = routes[url.pathname] ?? routes["*"];
		res
			.writeHead(200, { "content-type": "text/html; charset=utf-8", ...(route.headers ?? {}) })
			.end(route.body);
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	return { port: server.address().port, close: () => new Promise((r) => server.close(r)) };
}

/** A page whose only content is one of the add-on's web-accessible frames. */
export const OPENER_PAGE = `<!doctype html><title>opener</title><body><iframe src="${EXT_ORIGIN}/autofill-ui.html?parentOrigin=http%3A%2F%2Flocalhost"></iframe></body>`;

/** Start Firefox on a throwaway profile with the add-on installed. HEADED=1 shows the window. */
export async function launch() {
	const firefox = process.env.FIREFOX_BINARY;
	if (!firefox) throw new Error("FIREFOX_BINARY must name the Firefox to test");
	if (!existsSync(path.join(EXTENSION, "manifest.json"))) {
		throw new Error(
			`No build at ${EXTENSION}. Run: pnpm --filter @vault/platform-extension build:firefox`,
		);
	}
	const manifest = JSON.parse(readFileSync(path.join(EXTENSION, "manifest.json"), "utf8"));
	const addonId = manifest.browser_specific_settings.gecko.id;
	const profile = mkdtempSync(path.join(tmpdir(), "bramble-firefox-"));
	const prefs = {
		"extensions.webextensions.uuids": JSON.stringify({ [addonId]: UUID }),
		"browser.shell.checkDefaultBrowser": false,
		"browser.aboutwelcome.enabled": false,
		"browser.startup.homepage_override.mstone": "ignore",
		"datareporting.policy.dataSubmissionEnabled": false,
		"app.update.auto": false,
		// The browser's own password manager would offer to save the same logins.
		"signon.rememberSignons": false,
	};
	writeFileSync(
		path.join(profile, "user.js"),
		Object.entries(prefs)
			.map(([key, value]) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`)
			.join("\n"),
	);
	const args = ["--profile", profile, "--no-remote", "--remote-debugging-port", "0"];
	if (!process.env.HEADED) args.push("--headless");
	const child = spawn(firefox, args, {
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: "1" },
	});
	let log = "";
	const endpoint = await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`Firefox did not start:\n${log}`)), 60_000);
		const onData = (chunk) => {
			log += chunk;
			const found = log.match(/WebDriver BiDi listening on (ws:\/\/\S+)/);
			if (!found) return;
			clearTimeout(timer);
			resolve(found[1]);
		};
		child.stdout.on("data", onData);
		child.stderr.on("data", onData);
		child.once("exit", (code) => reject(new Error(`Firefox exited (${code}):\n${log}`)));
	});

	const ws = new WebSocket(`${endpoint}/session`);
	await new Promise((resolve, reject) => {
		ws.addEventListener("open", resolve, { once: true });
		ws.addEventListener("error", () => reject(new Error("no BiDi connection")), { once: true });
	});
	let nextId = 1;
	const pending = new Map();
	ws.addEventListener("message", (m) => {
		const data = JSON.parse(m.data);
		const waiter = pending.get(data.id);
		if (!waiter) return;
		pending.delete(data.id);
		if (data.type === "error") waiter.reject(new Error(`${waiter.method}: ${data.message}`));
		else waiter.resolve(data.result);
	});
	const send = (method, params = {}) =>
		new Promise((resolve, reject) => {
			const id = nextId++;
			pending.set(id, { resolve, reject, method });
			ws.send(JSON.stringify({ id, method, params }));
		});
	await send("session.new", { capabilities: {} });
	await send("webExtension.install", { extensionData: { type: "path", path: EXTENSION } });

	const contexts = async () => (await send("browsingContext.getTree", {})).contexts;

	/** The JSON-safe value of `expression` (awaited) in `context`. */
	async function evaluate(context, expression) {
		const r = await send("script.evaluate", {
			expression: `(async () => JSON.stringify(await (${expression})))()`,
			target: { context },
			awaitPromise: true,
			resultOwnership: "none",
			userActivation: true,
		});
		if (r.type !== "success") throw new Error(`evaluate failed: ${r.exceptionDetails?.text}`);
		return r.result.value === undefined ? undefined : JSON.parse(r.result.value);
	}

	async function click(context, x, y) {
		const actions = [
			{ type: "pointerMove", x: Math.round(x), y: Math.round(y), duration: 0 },
			{ type: "pointerDown", button: 0 },
			{ type: "pause", duration: 30 },
			{ type: "pointerUp", button: 0 },
		];
		await send("input.performActions", {
			context,
			actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions }],
		});
		await send("input.releaseActions", { context });
	}

	const browser = {
		contexts,
		evaluate,
		click,
		activate: (context) => send("browsingContext.activate", { context }),
		close: (context) => send("browsingContext.close", { context }),
		goto: (context, url) => send("browsingContext.navigate", { context, url, wait: "complete" }),
		/** The child frames of `context`. */
		async frames(context) {
			return (await contexts()).find((c) => c.context === context)?.children ?? [];
		},
		/** Real key presses, sent to whatever holds focus in `context`. */
		async type(context, text) {
			const actions = [...text].flatMap((key) => [
				{ type: "keyDown", value: key },
				{ type: "keyUp", value: key },
			]);
			await send("input.performActions", {
				context,
				actions: [{ type: "key", id: "keyboard", actions }],
			});
			await send("input.releaseActions", { context });
		},
		/** Click the centre of the element `expression` evaluates to. */
		async clickElement(context, expression) {
			const at = await evaluate(
				context,
				`(() => { const el = ${expression}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
			);
			if (!at) throw new Error(`no element: ${expression}`);
			await click(context, at.x, at.y);
		},
		/** Run `fn(root)` on the shadow root, closed or not, of the element `host` evaluates to. */
		async inShadow(context, host, fn) {
			const r = await send("script.evaluate", {
				expression: host,
				target: { context },
				awaitPromise: false,
				resultOwnership: "none",
				serializationOptions: { includeShadowTree: "all", maxDomDepth: 0 },
			});
			const root = r.result?.value?.shadowRoot;
			if (!root?.sharedId) throw new Error(`no shadow root on ${host}`);
			const called = await send("script.callFunction", {
				functionDeclaration: `async function (root) { return JSON.stringify(await (${fn})(root)); }`,
				arguments: [{ sharedId: root.sharedId }],
				target: { context },
				awaitPromise: true,
				resultOwnership: "none",
			});
			if (called.type !== "success") {
				throw new Error(`inShadow failed: ${called.exceptionDetails?.text}`);
			}
			return called.result.value === undefined ? undefined : JSON.parse(called.result.value);
		},
		/** Open one of the add-on's own pages in a new tab; `opener` is a url serving OPENER_PAGE. */
		async openExtensionPage(tab, opener, page) {
			await browser.goto(tab, opener);
			const frame = await waitFor(
				async () => (await browser.frames(tab)).find((f) => f.url.startsWith(EXT_ORIGIN)),
				"the opener frame",
			);
			const before = new Set((await contexts()).map((c) => c.context));
			await evaluate(frame.context, `!!window.open(browser.runtime.getURL(${JSON.stringify(page)}))`);
			const opened = await waitFor(
				async () =>
					(await contexts()).find((c) => !before.has(c.context) && c.url.startsWith(EXT_ORIGIN)),
				page,
			);
			return opened.context;
		},
		/** Create the first vault through the setup flow, as extension/helpers.ts createVault does. */
		async createVault(tab, opener) {
			const options = await browser.openExtensionPage(tab, opener, "options.html");
			const password = (n) => `document.querySelectorAll('input[type="password"]')[${n}]`;
			const button = (label) =>
				`[...document.querySelectorAll("button")].find((b) => ${label}.test(b.textContent) && !b.disabled)`;
			await waitFor(() => evaluate(options, `!!${password(1)}`), "the setup form");
			for (const n of [0, 1]) {
				await browser.clickElement(options, password(n));
				await browser.type(options, STRONG_PW);
			}
			await waitFor(() => evaluate(options, `!!${button("/Create vault/i")}`), "Create vault");
			await browser.clickElement(options, button("/Create vault/i"));
			await waitFor(() => evaluate(options, `!!${button("/I've saved it/i")}`), "recovery", 30_000);
			await browser.clickElement(options, button("/I've saved it/i"));
			await waitFor(
				() => evaluate(options, "/Vault ready/i.test(document.body.innerText)"),
				"Vault ready",
				30_000,
			);
			await browser.close(options);
			await browser.activate(tab);
		},
		async quit() {
			await Promise.race([send("browser.close").catch(() => {}), sleep(3000)]);
			ws.close();
			await sleep(500);
			if (child.exitCode === null) child.kill("SIGTERM");
			await sleep(500);
			rmSync(profile, { recursive: true, force: true });
		},
	};
	return browser;
}
