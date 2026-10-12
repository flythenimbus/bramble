/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// The picker follows its anchor field frame by frame. A field that has gone measures
// 0x0 at the document origin, so the loop used to park the picker in the page's
// top-left corner and leave it there: an SPA route change swapped the login form out
// and the dropdown stayed on screen, detached from anything it could fill.

// Inlined, not a const: vi.mock is hoisted above module scope, and picker.ts reads
// getURL at import time.
vi.mock("./content-api", () => ({
	api: {
		runtime: {
			id: "abcdefghijklmnopabcdefghijklmnop",
			getURL: (p: string) => `chrome-extension://abcdefghijklmnopabcdefghijklmnop/${p}`,
		},
		i18n: { getMessage: (key: string) => key },
	},
}));

let teardown: (() => void) | null = null;
vi.mock("./lifecycle", () => ({
	onTeardown: (cb: () => void) => {
		teardown = cb;
	},
}));

const { picker } = await import("./picker");

const MATCH = { id: "entry-1", name: "Example", secondary: "user@example.com" };
const BOX = { x: 40, y: 300, width: 320, height: 32 };

type Box = typeof BOX;

function stubRect(el: Element, r: Box): void {
	el.getBoundingClientRect = () =>
		({
			x: r.x,
			y: r.y,
			left: r.x,
			top: r.y,
			width: r.width,
			height: r.height,
			right: r.x + r.width,
			bottom: r.y + r.height,
			toJSON: () => ({}),
		}) as DOMRect;
}

/** The picker's host div (random id, closed shadow root). */
function hostEl(): HTMLElement | null {
	return document.body.querySelector<HTMLElement>("div[id^='tp-']");
}

/** The iframe renderer is hidden rather than removed on dismissal, so display is the tell. */
function pickerIsShowing(): boolean {
	const host = hostEl();
	return !!host && host.style.display !== "none";
}

/** Run the position tracker one frame. */
function frame(): Promise<void> {
	return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

/** A login form with the picker open on its field, one frame in. */
async function openOnField(): Promise<HTMLInputElement> {
	document.body.innerHTML = `<form><input id="user" type="email" name="email" /></form>`;
	const field = document.getElementById("user") as HTMLInputElement;
	stubRect(field, BOX);
	picker.showMatches([MATCH], field);
	await frame();
	return field;
}

const EXT_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

type ReadyIframe = {
	/** What reached the iframe document over its port, from the handshake on. */
	posts: unknown[];
	/** The iframe's end of the port, to answer the content script with. */
	uiPort: MessagePort;
	/** The iframe's window, for posting on the window the way a page could. */
	uiWindow: Window;
};

let openPorts: MessagePort[] = [];

// The early-click guard reads performance.now(); tests that click move this clock past it.
let clock = 0;
function freezeClock(): void {
	clock = 10_000;
	vi.spyOn(performance, "now").mockImplementation(() => clock);
}

/** Let queued port messages land. */
function settle(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 20));
}

/** Mount the picker on `field` and play the iframe's side of the handshake: READY on the window,
 * then take the port the content script hands over and ack on it. */
async function readyIframe(field: HTMLInputElement): Promise<ReadyIframe> {
	// The host parks the iframe in a CLOSED shadow root, so it cannot be queried for. Catch it
	// as it is made instead, which is also the only moment its contentWindow can be stubbed.
	const posts: unknown[] = [];
	let uiPort: MessagePort | null = null;
	const uiWindow = {
		postMessage: (m: unknown, _origin: string, transfer?: MessagePort[]) => {
			if ((m as { type?: string })?.type !== "UI_CONNECT" || !transfer?.[0]) return;
			uiPort = transfer[0];
			openPorts.push(uiPort);
			uiPort.onmessage = (e) => posts.push(e.data);
			uiPort.postMessage({ type: "UI_CONNECTED" });
		},
	} as unknown as Window;
	let iframe: HTMLIFrameElement | null = null;
	const createElement = document.createElement.bind(document);
	const spy = vi.spyOn(document, "createElement").mockImplementation(((
		tag: string,
		...rest: unknown[]
	) => {
		const el = createElement(tag, ...(rest as []));
		if (tag === "iframe") {
			iframe = el as HTMLIFrameElement;
			Object.defineProperty(el, "contentWindow", { configurable: true, value: uiWindow });
		}
		return el;
	}) as typeof document.createElement);
	picker.showMatches([MATCH], field, {});
	spy.mockRestore();
	if (!iframe) throw new Error("no iframe mounted");
	window.dispatchEvent(
		new MessageEvent("message", {
			data: { type: "AUTOFILL_UI_READY" },
			origin: EXT_ORIGIN,
			source: uiWindow,
		}),
	);
	await vi.waitFor(() => {
		if (!posts.some((m) => (m as { type?: string })?.type === "RENDER_MATCHES")) {
			throw new Error("first render never arrived over the port");
		}
	});
	posts.length = 0;
	return { posts, uiPort: uiPort as unknown as MessagePort, uiWindow };
}

/** Make the visible-picker check pass in jsdom, which has no layout: the host on screen and
 * opaque, and the hit test answering with the host over the picker and the field elsewhere. */
function trustHost(
	field: HTMLInputElement,
	styleFor: (el: Element) => Partial<CSSStyleDeclaration> = () => ({}),
	host: HTMLElement = hostEl()!,
): void {
	stubRect(host, { x: 40, y: 334, width: 320, height: 120 });
	vi.spyOn(window, "getComputedStyle").mockImplementation(
		(el: Element) =>
			({
				visibility: "visible",
				display: "block",
				opacity: "1",
				filter: "none",
				mixBlendMode: "normal",
				clipPath: "none",
				...styleFor(el),
			}) as CSSStyleDeclaration,
	);
	Object.defineProperty(document, "elementFromPoint", {
		configurable: true,
		value: (_x: number, y: number) => (y > BOX.y + BOX.height ? host : field),
	});
}

afterEach(() => {
	// Also clears the iframe's readiness timer, which would otherwise fall through to
	// the shadow renderer in the middle of a later case.
	teardown?.();
	document.body.innerHTML = "";
	for (const port of openPorts) port.close();
	openPorts = [];
	vi.restoreAllMocks();
	delete (document as { elementFromPoint?: unknown }).elementFromPoint;
});

describe("picker: losing the anchor field", () => {
	it("sits under a field that is still there", async () => {
		await openOnField();

		expect(pickerIsShowing()).toBe(true);
		expect(hostEl()!.style.transform).toBe("translate3d(40px, 334px, 0)");
	});

	it("dismisses when a route change unmounts the field", async () => {
		const field = await openOnField();

		// The rect stub outlives the removal, so being detached is the only tell.
		field.remove();
		await frame();

		expect(pickerIsShowing()).toBe(false);
		expect(picker.anchorField()).toBeNull();
	});

	it("dismisses instead of parking in the top-left when the field loses its box", async () => {
		const field = await openOnField();

		// What a detached or display:none field measures: no box, at the origin.
		stubRect(field, { x: 0, y: 0, width: 0, height: 0 });
		await frame();

		expect(pickerIsShowing()).toBe(false);
		expect(hostEl()!.style.transform).not.toBe("translate3d(0px, 2px, 0)");
		expect(picker.anchorField()).toBeNull();
	});

	it("keeps following a field that only moved", async () => {
		const field = await openOnField();

		stubRect(field, { ...BOX, y: 500 });
		await frame();

		expect(pickerIsShowing()).toBe(true);
		expect(hostEl()!.style.transform).toBe("translate3d(40px, 534px, 0)");
		expect(picker.anchorField()).toBe(field);
	});

	it("clears a mid-scroll hide on the way out, so the next open is visible", async () => {
		const field = await openOnField();

		// Move (hides mid-scroll), then take the field away.
		stubRect(field, { ...BOX, y: 500 });
		await frame();
		expect(hostEl()!.style.visibility).toBe("hidden");
		field.remove();
		await frame();

		expect(hostEl()!.style.visibility).toBe("");
	});
});

// The iframe renderer keeps its own render cache, separate from the shadow one's, and it decides
// what to re-post. A row whose STATE changes without its content changing is the case that cache
// gets wrong: idle and busy hash the same unless the state is part of the key, the re-post is
// dropped as redundant, and the alias row never leaves the state it was first drawn in. This is
// the primary renderer, so that is the entire spinner. See docs/email-aliases.md.
describe("picker: the iframe renderer re-posts when a row's state changes", () => {
	it("posts each alias state, rather than treating the second as redundant", async () => {
		const field = document.createElement("input");
		document.body.append(field);
		stubRect(field, BOX);
		const { posts } = await readyIframe(field);

		picker.showMatches([], field, { alias: { state: "idle" } });
		picker.showMatches([], field, { alias: { state: "busy" } });
		picker.showMatches([], field, { alias: { state: "error", message: "nope" } });
		await settle();

		const states = posts
			.filter((m): m is { type: string; alias?: { state: string } } => {
				return (m as { type?: string })?.type === "RENDER_MATCHES";
			})
			.map((m) => m.alias?.state);
		expect(states).toEqual(["idle", "busy", "error"]);
	});

	// The dedupe still has to work, or every DOM mutation reflickers the dropdown.
	it("still skips a genuinely identical re-render", async () => {
		const field = document.createElement("input");
		document.body.append(field);
		stubRect(field, BOX);
		const { posts } = await readyIframe(field);

		picker.showMatches([], field, { alias: { state: "idle" } });
		picker.showMatches([], field, { alias: { state: "idle" } });
		await settle();

		const renders = posts.filter((m) => (m as { type?: string })?.type === "RENDER_MATCHES");
		expect(renders).toHaveLength(1);
	});
});

// The iframe sits in the page's DOM, so the page shares the window both ends would otherwise talk
// on and can post as the content script. Picks therefore ride a port handed to the iframe at the
// handshake, and are honoured only from there (GHSA-mvjj-4qqq-xr7h). See docs/autofill.md.
describe("picker: only the iframe's port can pick", () => {
	async function setup(): Promise<
		ReadyIframe & { picks: [string, boolean][]; field: HTMLInputElement }
	> {
		document.body.innerHTML = `<form><input id="user" type="email" name="email" /></form>`;
		const field = document.getElementById("user") as HTMLInputElement;
		stubRect(field, BOX);
		const picks: [string, boolean][] = [];
		picker.onPick((id, otpOnly) => picks.push([id, otpOnly]));
		const ready = await readyIframe(field);
		trustHost(field);
		return { ...ready, picks, field };
	}

	it("honours a pick sent over the port", async () => {
		const { uiPort, picks } = await setup();

		uiPort.postMessage({ type: "UI_PICK", entryId: MATCH.id, otpOnly: false });

		await vi.waitFor(() => expect(picks).toEqual([[MATCH.id, false]]));
	});

	it("ignores a pick for an entry it never rendered", async () => {
		const { uiPort, picks } = await setup();

		uiPort.postMessage({ type: "UI_PICK", entryId: "not-rendered", otpOnly: false });
		await settle();

		expect(picks).toEqual([]);
	});

	// Opacity and filters do not inherit, so the host's own computed style never shows an
	// ancestor's. The DEF CON 33 extension-clickjacking variants hide the picker exactly so.
	it.each([
		["opacity", { opacity: "0" }],
		["filter", { filter: "opacity(0)" }],
	])("refuses a pick while an ancestor's %s hides the picker", async (_, style) => {
		const { uiPort, picks, field } = await setup();
		trustHost(field, (el) => (el === document.documentElement ? style : {}));

		uiPort.postMessage({ type: "UI_PICK", entryId: MATCH.id, otpOnly: false });
		await settle();

		expect(picks).toEqual([]);
	});

	it("still takes a pick under a root filter that only recolours (Dark Reader's filter mode)", async () => {
		const { uiPort, picks, field } = await setup();
		trustHost(field, (el) =>
			el === document.documentElement
				? { filter: "invert(1) hue-rotate(180deg) contrast(0.9)" }
				: {},
		);

		uiPort.postMessage({ type: "UI_PICK", entryId: MATCH.id, otpOnly: false });

		await vi.waitFor(() => expect(picks).toEqual([[MATCH.id, false]]));
	});

	it("ignores a pick posted on the window, even from the iframe's own window", async () => {
		const { uiWindow, picks } = await setup();

		window.dispatchEvent(
			new MessageEvent("message", {
				data: { type: "UI_PICK", entryId: MATCH.id, otpOnly: false },
				origin: EXT_ORIGIN,
				source: uiWindow,
			}),
		);
		await settle();

		expect(picks).toEqual([]);
	});
});

// A page that can open the picker can open it under a click the user is already making (a
// double-click lure, or moving the field under the cursor). Clicks that land before the picker
// has sat still for 500 ms are dropped; keyboard picks are deliberate and are not timed.
describe("picker: early clicks", () => {
	async function setup(): Promise<
		ReadyIframe & { picks: [string, boolean][]; field: HTMLInputElement }
	> {
		document.body.innerHTML = `<form><input id="user" type="email" name="email" /></form>`;
		const field = document.getElementById("user") as HTMLInputElement;
		stubRect(field, BOX);
		const picks: [string, boolean][] = [];
		picker.onPick((id, otpOnly) => picks.push([id, otpOnly]));
		freezeClock();
		const ready = await readyIframe(field);
		trustHost(field);
		return { ...ready, picks, field };
	}

	const click = { type: "UI_PICK", entryId: MATCH.id, otpOnly: false, pointer: true };

	it("drops a click in the picker's first 500 ms on screen", async () => {
		const { uiPort, picks } = await setup();
		clock += 300;

		uiPort.postMessage(click);
		await settle();

		expect(picks).toEqual([]);
	});

	it("takes a click once the picker has sat still for 500 ms", async () => {
		const { uiPort, picks } = await setup();
		clock += 600;

		uiPort.postMessage(click);

		await vi.waitFor(() => expect(picks).toEqual([[MATCH.id, false]]));
	});

	it("starts the clock again when the picker moves", async () => {
		const { uiPort, picks, field } = await setup();
		clock += 600;
		stubRect(field, { ...BOX, x: 80 });
		await frame();

		uiPort.postMessage(click);
		await settle();

		expect(picks).toEqual([]);
	});

	it("does not time keyboard picks", async () => {
		const { uiPort, picks } = await setup();

		uiPort.postMessage({ ...click, pointer: undefined });

		await vi.waitFor(() => expect(picks).toEqual([[MATCH.id, false]]));
	});
});

// Enter belongs to the page's form unless a row is highlighted. Waiting for the iframe to report
// its highlight raced the user's Enter (it lost in e2e), so the gate follows the keys we sent.
describe("picker: Enter after an arrow key", () => {
	async function setup(): Promise<{ field: HTMLInputElement; posts: unknown[] }> {
		document.body.innerHTML = `<form><input id="user" type="email" name="email" /></form>`;
		const field = document.getElementById("user") as HTMLInputElement;
		stubRect(field, BOX);
		field.focus();
		const { posts } = await readyIframe(field);
		return { field, posts };
	}

	const key = (k: string) => new KeyboardEvent("keydown", { key: k, cancelable: true });

	it("is taken at once, without waiting on the iframe's highlight report", async () => {
		const { posts } = await setup();

		expect(picker.handleKey(key("ArrowDown"))).toBe(true);
		expect(picker.handleKey(key("Enter"))).toBe(true);

		await vi.waitFor(() => expect(posts).toContainEqual({ type: "UI_KEY", key: "Enter" }));
	});

	it("falls through to the form when no row was highlighted", async () => {
		await setup();

		expect(picker.handleKey(key("Enter"))).toBe(false);
	});

	it("falls through again once a re-render clears the highlight", async () => {
		const { field } = await setup();
		picker.handleKey(key("ArrowDown"));

		picker.showMatches([MATCH, { ...MATCH, id: "entry-2" }], field);

		expect(picker.handleKey(key("Enter"))).toBe(false);
	});
});

// The fallback renders in the page's own DOM, and a page can force it by keeping the iframe from
// loading (COEP, or removing its host), so it needs the same pick-time check as the iframe.
describe("picker: the shadow fallback", () => {
	/** Fall back to the shadow renderer on `field`, returning its row and the mousedown handler. */
	function fallBack(field: HTMLInputElement): {
		host: HTMLElement;
		row: Element;
		mousedown: EventListener;
	} {
		const shadows = new Map<Element, ShadowRoot>();
		const attach = Element.prototype.attachShadow;
		vi.spyOn(Element.prototype, "attachShadow").mockImplementation(function (
			this: Element,
			init: ShadowRootInit,
		) {
			const root = attach.call(this, init);
			shadows.set(this, root);
			return root;
		});
		const mousedowns = new Map<EventTarget, EventListener>();
		const add = EventTarget.prototype.addEventListener;
		vi.spyOn(EventTarget.prototype, "addEventListener").mockImplementation(function (
			this: EventTarget,
			type: string,
			fn: EventListenerOrEventListenerObject | null,
			opts?: boolean | AddEventListenerOptions,
		) {
			if (type === "mousedown") mousedowns.set(this, fn as EventListener);
			return add.call(this, type, fn, opts);
		});
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			picker.showMatches([MATCH], field);
			vi.advanceTimersByTime(700);
		} finally {
			vi.useRealTimers();
		}
		const host = document.getElementById("bramble-autofill-dropdown");
		const shadow = host && shadows.get(host);
		const row = shadow?.querySelector("[data-entry-id]");
		const mousedown = shadow && mousedowns.get(shadow);
		if (!host || !row || !mousedown) throw new Error("never fell back to the shadow renderer");
		return { host, row, mousedown };
	}

	/** jsdom will not mark an event trusted, so hand the listener a stand-in that is. */
	function trustedMousedown(target: Element): Event {
		const inner = new MouseEvent("mousedown", { bubbles: true, composed: true });
		return new Proxy(inner, {
			get(event, property) {
				if (property === "isTrusted") return true;
				if (property === "target") return target;
				const value = Reflect.get(event, property, event);
				return typeof value === "function" ? value.bind(event) : value;
			},
		});
	}

	function setup(): { field: HTMLInputElement; picks: [string, boolean][] } {
		document.body.innerHTML = `<form><input id="user" type="email" name="email" /></form>`;
		const field = document.getElementById("user") as HTMLInputElement;
		stubRect(field, BOX);
		const picks: [string, boolean][] = [];
		picker.onPick((id, otpOnly) => picks.push([id, otpOnly]));
		return { field, picks };
	}

	it("takes a real click on a visible row", () => {
		const { field, picks } = setup();
		freezeClock();
		const { host, row, mousedown } = fallBack(field);
		trustHost(field, () => ({}), host);
		clock += 600;

		mousedown(trustedMousedown(row));

		expect(picks).toEqual([[MATCH.id, false]]);
	});

	it("refuses a click in its first 500 ms on screen", () => {
		const { field, picks } = setup();
		freezeClock();
		const { host, row, mousedown } = fallBack(field);
		trustHost(field, () => ({}), host);
		clock += 300;

		mousedown(trustedMousedown(row));

		expect(picks).toEqual([]);
	});

	it("refuses a click while the page has made the dropdown invisible", () => {
		const { field, picks } = setup();
		freezeClock();
		const { host, row, mousedown } = fallBack(field);
		trustHost(field, (el) => (el === host ? { opacity: "0" } : {}), host);
		clock += 600;

		mousedown(trustedMousedown(row));

		expect(picks).toEqual([]);
	});
});
