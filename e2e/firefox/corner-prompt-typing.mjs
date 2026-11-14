#!/usr/bin/env node
// The Firefox half of extension/corner-prompt-typing.spec.ts: a username typed on the save card
// reaches the card and not the page, in the browser the report came from. The page listens from
// its first script, at window capture.
//
// Manual, not CI: it wants a stock Firefox (see driver.mjs). Build first:
//
//   pnpm --filter @vault/platform-extension build:firefox
//   FIREFOX_BINARY=/path/to/firefox node e2e/firefox/corner-prompt-typing.mjs

import { launch, OPENER_PAGE, serve, sleep, waitFor } from "./driver.mjs";

const TYPED = [
	"keydown",
	"keypress",
	"keyup",
	"beforeinput",
	"input",
	"compositionstart",
	"compositionupdate",
	"compositionend",
	"paste",
	"copy",
	"cut",
];

const LOGIN = `<!doctype html><html><head><title>login</title>
<script>
	window.__heard = [];
	${JSON.stringify(TYPED)}.forEach(function (type) {
		function hear(where) {
			return function (e) { window.__heard.push(where + ":" + type + ":" + (e.key || e.data || "")); };
		}
		window.addEventListener(type, hear("window-capture"), true);
		document.addEventListener(type, hear("document-bubble"));
	});
</script></head><body>
<form id="login">
	<input id="user" name="username" type="text" autocomplete="username" />
	<input id="pass" name="password" type="password" autocomplete="current-password" />
	<button type="submit" id="go">Sign in</button>
</form>
<script>
	document.getElementById('login').addEventListener('submit', function (e) {
		e.preventDefault();
		setTimeout(function () { document.getElementById('login').remove(); }, 100);
	});
</script></body></html>`;

const server = await serve({
	"/opener": { body: OPENER_PAGE },
	"/coep": {
		body: LOGIN,
		headers: {
			"cross-origin-embedder-policy": "require-corp",
			"cross-origin-opener-policy": "same-origin",
		},
	},
	"/csp": {
		body: LOGIN,
		headers: { "content-security-policy": "default-src 'self' 'unsafe-inline'; frame-src 'none'" },
	},
	"*": { body: LOGIN },
});
const firefox = await launch();
const HOST = `document.getElementById("bramble-corner-prompt")`;

let failed = 0;
function check(name, ok, detail) {
	if (!ok) failed++;
	console.log(`${ok ? "pass" : "FAIL"}  ${name}${ok ? "" : `  ${JSON.stringify(detail)}`}`);
}

/** Sign in at `url` with only a password typed, unless `username` is given; the card follows. */
async function raiseSaveCard(tab, url, username = "") {
	await firefox.goto(tab, url);
	if (username) {
		await firefox.clickElement(tab, `document.getElementById("user")`);
		await firefox.type(tab, username);
	}
	await firefox.clickElement(tab, `document.getElementById("pass")`);
	await firefox.type(tab, "Al1ce-Keys-Pw");
	await firefox.clickElement(tab, `document.getElementById("go")`);
	await waitFor(() => firefox.evaluate(tab, `!!${HOST}`), "the save card");
	await firefox.evaluate(tab, "(window.__heard.length = 0, true)");
}

/** The card's Username box and frame, and where to click. */
const card = (tab) =>
	firefox.inShadow(
		tab,
		HOST,
		`(root) => {
			const centre = (el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; };
			const box = root.querySelector("#tp-username");
			const frame = root.querySelector("iframe.tp-field");
			return {
				box: { hidden: box.hidden, readOnly: box.readOnly, value: box.value, at: centre(box) },
				frame: frame && !frame.hidden ? { live: true, at: centre(frame) } : { live: false },
				save: centre(root.querySelector('[data-tp-action="save"]')),
				dismiss: centre(root.querySelector('[data-tp-action="dismiss"]')),
			};
		}`,
	);

const heard = (tab) => firefox.evaluate(tab, "window.__heard");
const fieldFrame = async (tab) =>
	(await firefox.frames(tab)).find((f) => f.url.includes("corner-field.html"));

/** Click at `at` and wait for the caret to be in the card, as a person does before typing: a key
 *  sent in the same instant as the click lands on the page with nothing focused. */
async function clickInto(tab, at) {
	await waitFor(async () => {
		await firefox.click(tab, at.x, at.y);
		if (!(await firefox.evaluate(tab, `document.activeElement === ${HOST}`))) return false;
		const frame = await fieldFrame(tab);
		if (!frame) return true;
		return firefox.evaluate(frame.context, "document.activeElement instanceof HTMLInputElement");
	}, "the caret in the Username box");
}
/** What the Username box holds, wherever it lives. */
async function typed(tab) {
	const frame = await fieldFrame(tab);
	if (!frame) return (await card(tab)).box.value;
	return firefox.evaluate(frame.context, `document.querySelector("input").value`);
}

/** A page that may keep the frame out: whichever way this Firefox goes, nothing typed reaches it. */
async function blockedOrNot(tab, url, label) {
	await raiseSaveCard(tab, url, "bob");
	await sleep(1500);
	const state = await card(tab);
	if (state.frame.live) {
		await clickInto(tab, state.frame.at);
		await firefox.type(tab, "zzz");
		check(`${label}: the frame loads, and the page hears nothing`, (await heard(tab)).length === 0);
		check(`${label}: the typing is in the frame`, (await typed(tab)).includes("zzz"));
	} else {
		check(`${label}: the frame is kept out, and the box left is read-only`, state.box.readOnly);
		await firefox.click(tab, state.box.at.x, state.box.at.y);
		await firefox.type(tab, "zzz");
		check(`${label}: it takes no typing`, (await card(tab)).box.value === "bob");
	}
	await firefox.click(tab, state.dismiss.x, state.dismiss.y);
	await waitFor(() => firefox.evaluate(tab, `!${HOST}`), "the card to close");
}

try {
	const [{ context: tab }] = await firefox.contexts();
	const local = `http://localhost:${server.port}`;
	await firefox.createVault(tab, `${local}/opener`);
	console.log((await firefox.evaluate(tab, "navigator.userAgent")).match(/Firefox\/[\d.]+/)?.[0]);

	// The reported case: a form with no username, so the user types it on the card.
	await raiseSaveCard(tab, `${local}/`);
	const state = await waitFor(async () => {
		const now = await card(tab);
		return now.frame.live || !now.box.readOnly ? now : null;
	}, "a Username box to type in");
	check("the box to type in is the frame, and the one in the page is read-only", state.frame.live && state.box.readOnly && state.box.hidden, state);
	await clickInto(tab, state.frame.live ? state.frame.at : state.box.at);
	await firefox.type(tab, "carol");
	check("the page hears no key, input or clipboard event", (await heard(tab)).length === 0, (await heard(tab)).slice(0, 4));
	const reached = await firefox.evaluate(
		tab,
		`(() => { document.execCommand("selectAll"); const selected = String(window.getSelection()); document.execCommand("insertText", false, "EVIL"); return selected; })()`,
	);
	check("the page cannot read the box", !reached.includes("carol"), reached);
	check("nor write into it", (await typed(tab)) === "carol", await typed(tab));
	await firefox.click(tab, state.save.x, state.save.y);
	await waitFor(() => firefox.evaluate(tab, `!${HOST}`), "the card to close");

	const popup = await firefox.openExtensionPage(tab, `${local}/opener`, "popup.html");
	const list = await waitFor(async () => {
		const text = await firefox.evaluate(popup, "document.body.innerText");
		return /Items \(1\)/.test(text) ? text : null;
	}, "the saved login");
	const saved = list.slice(list.indexOf("Items (1)")).split("\n").filter(Boolean).slice(0, 4);
	check("the login is saved with the typed username", saved.includes("carol"), saved);
	await firefox.close(popup);
	await firefox.activate(tab);

	// Another host, so the login just saved does not turn these into update cards.
	const other = `http://127.0.0.1:${server.port}`;
	await blockedOrNot(tab, `${other}/coep`, "under COEP");
	await blockedOrNot(tab, `${other}/csp`, "under frame-src 'none'");
} catch (error) {
	failed++;
	console.error(error);
} finally {
	await firefox.quit();
	await server.close();
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
