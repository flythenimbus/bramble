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
