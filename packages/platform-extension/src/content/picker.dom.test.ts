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

afterEach(() => {
	// Also clears the iframe's readiness timer, which would otherwise fall through to
	// the shadow renderer in the middle of a later case.
	teardown?.();
	document.body.innerHTML = "";
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
	const EXT_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

	/** Mount the picker, then complete the iframe's readiness handshake so posts go out live
	 * rather than being held as a pending render. Returns the posts seen from then on. */
	function readyIframe(field: HTMLInputElement): unknown[] {
		// The host parks the iframe in a CLOSED shadow root, so it cannot be queried for. Catch it
		// as it is made instead, which is also the only moment its contentWindow can be stubbed.
		const posts: unknown[] = [];
		let iframe: HTMLIFrameElement | null = null;
		const createElement = document.createElement.bind(document);
		const spy = vi.spyOn(document, "createElement").mockImplementation(((
			tag: string,
			...rest: unknown[]
		) => {
			const el = createElement(tag, ...(rest as []));
			if (tag === "iframe") {
				iframe = el as HTMLIFrameElement;
				Object.defineProperty(el, "contentWindow", {
					configurable: true,
					value: { postMessage: (m: unknown) => posts.push(m) },
				});
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
				source: (iframe as HTMLIFrameElement).contentWindow as unknown as Window,
			}),
		);
		posts.length = 0;
		return posts;
	}

	it("posts each alias state, rather than treating the second as redundant", () => {
		const field = document.createElement("input");
		document.body.append(field);
		stubRect(field, BOX);
		const posts = readyIframe(field);

		picker.showMatches([], field, { alias: { state: "idle" } });
		picker.showMatches([], field, { alias: { state: "busy" } });
		picker.showMatches([], field, { alias: { state: "error", message: "nope" } });

		const states = posts
			.filter((m): m is { type: string; alias?: { state: string } } => {
				return (m as { type?: string })?.type === "RENDER_MATCHES";
			})
			.map((m) => m.alias?.state);
		expect(states).toEqual(["idle", "busy", "error"]);
	});

	// The dedupe still has to work, or every DOM mutation reflickers the dropdown.
	it("still skips a genuinely identical re-render", () => {
		const field = document.createElement("input");
		document.body.append(field);
		stubRect(field, BOX);
		const posts = readyIframe(field);

		picker.showMatches([], field, { alias: { state: "idle" } });
		picker.showMatches([], field, { alias: { state: "idle" } });

		const renders = posts.filter((m) => (m as { type?: string })?.type === "RENDER_MATCHES");
		expect(renders).toHaveLength(1);
	});
});
