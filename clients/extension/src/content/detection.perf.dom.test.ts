/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import { couldBeCandidate, parsePageFields, resetDomScanForTest } from "./detection";

// Guards issue #59. parsePageFields used to run one hand-rolled JS traversal per
// selector - 21 of them, each calling matches() on every element in the document
// - so a YouTube watch page (50k elements, 2 inputs) cost ~675ms per parse and
// the content script burned hundreds of milliseconds a second. The rewrite does
// one native query and filters the collected inputs, which is what these counts
// pin down: selector work must track the number of INPUTS, not the page size.

/** A page of `filler` inert nodes around one small login form. */
function buildPage(filler: number): void {
	const parts = [
		'<form><input name="email" type="email"><input name="password" type="password"></form>',
	];
	for (let i = 0; i < filler; i++) parts.push(`<div class="pad"><span>${i}</span></div>`);
	document.body.innerHTML = parts.join("");
	resetDomScanForTest();
}

/** How many Element.matches() calls `run` makes. */
function countMatches(run: () => void): number {
	const real = Element.prototype.matches;
	let calls = 0;
	Element.prototype.matches = function (this: Element, selector: string) {
		calls += 1;
		return real.call(this, selector);
	};
	try {
		run();
	} finally {
		Element.prototype.matches = real;
	}
	return calls;
}

describe("parsePageFields cost", () => {
	it("does not scale its selector matching with page size", () => {
		buildPage(20);
		const small = countMatches(() => {
			parsePageFields();
		});
		const smallElements = document.querySelectorAll("*").length;

		buildPage(4000);
		const large = countMatches(() => {
			parsePageFields();
		});

		expect(document.querySelectorAll("*").length).toBeGreaterThan(smallElements * 50);
		expect(large).toBe(small);
	});

	it("stays within a small constant for a two-field page", () => {
		buildPage(500);
		expect(
			countMatches(() => {
				parsePageFields();
			}),
		).toBeLessThan(100);
	});

	it("finds the fields it is counting", () => {
		buildPage(50);
		const model = parsePageFields();
		expect(model.login.username?.getAttribute("name")).toBe("email");
		expect(model.login.password?.getAttribute("name")).toBe("password");
	});
});

describe("couldBeCandidate", () => {
	function input(attrs: string): HTMLInputElement {
		document.body.innerHTML = `<input ${attrs}>`;
		return document.body.firstElementChild as HTMLInputElement;
	}

	it("accepts the types a rung can claim", () => {
		for (const attrs of ['type="text"', 'type="password"', 'type="tel"', 'type="month"', ""]) {
			expect(couldBeCandidate(input(attrs))).toBe(true);
		}
	});

	it("rejects what no rung can claim, without parsing", () => {
		for (const attrs of [
			'type="checkbox"',
			'type="hidden"',
			'type="submit"',
			"readonly",
			"disabled",
		]) {
			expect(couldBeCandidate(input(attrs))).toBe(false);
		}
	});

	it("rejects non-input targets", () => {
		document.body.innerHTML = `<textarea></textarea><div contenteditable="true"></div>`;
		expect(couldBeCandidate(document.querySelector("textarea"))).toBe(false);
		expect(couldBeCandidate(document.querySelector("div"))).toBe(false);
		expect(couldBeCandidate(null)).toBe(false);
	});
});
