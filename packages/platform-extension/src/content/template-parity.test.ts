// autofill-ui.ts carries its own copy of `html` / `escapeHtml` rather than importing
// content/template.ts, and that duplication is deliberate: the two are separate rollup
// entries, so a shared module would be hoisted into a chunk and the content script has to
// bundle flat (it loads as a classic script). See vite.config.ts.
//
// What the duplication costs is a way to drift. These are escapers, so drift means one entry
// gaining an XSS hole the other doesn't have, silently. Nothing else in the build would
// notice, so this test compares the two implementations directly. If it fails, fix BOTH
// copies; do not "resolve" it by importing one from the other.

import { describe, expect, it } from "vitest";
import uiSource from "../autofill-ui.ts?raw";
import { html as uiHtml } from "../autofill-ui-template";
import aliasSource from "./html/dropdown-alias.ts?raw";
import { html as contentHtml } from "./template";

const HOSTILE = [
	"<script>alert(1)</script>",
	'" onerror="alert(1)',
	"' onclick='alert(1)",
	"a & b < c > d",
	"&amp;already-escaped",
	"",
	"плохой ввод",
	"</textarea><svg onload=alert(1)>",
];

describe("autofill-ui and content templating stay identical", () => {
	it("escapes every interpolation the same way", () => {
		for (const value of HOSTILE) {
			expect(uiHtml`<p>${value}</p>`).toBe(contentHtml`<p>${value}</p>`);
		}
	});

	it("treats arrays as pre-escaped markup in both", () => {
		const parts = ["<b>", "kept", "</b>"];
		expect(uiHtml`<div>${parts}</div>`).toBe(contentHtml`<div>${parts}</div>`);
	});

	it("agrees on nullish and non-string values", () => {
		for (const value of [null, undefined, 0, false, 12.5]) {
			expect(uiHtml`<p>${value}</p>`).toBe(contentHtml`<p>${value}</p>`);
		}
	});
});

// The alias row exists twice for the same reason the escaper does, and unlike the escaper it is
// markup a person edits. A row added to one renderer and not the other is invisible until a
// user on a COEP page (or not on one) meets the half that was not updated. Comparing the
// rendered output catches the drift the escaper test cannot.
describe("the email-alias row is identical in both renderers", () => {
	/** The iframe entry is self-contained by design and runs side effects on import, so its row is
	 * read as source rather than imported. Comparing source is the point: this fails when one
	 * copy moves and the other does not. */
	function uiAliasRowSource(): string {
		const src = uiSource;
		const start = src.indexOf("function aliasRow(");
		expect(start).toBeGreaterThan(-1);
		return src.slice(start, src.indexOf("\nfunction ", start + 1));
	}

	function contentAliasRowSource(): string {
		const src = aliasSource;
		const start = src.indexOf("export function dropdownAlias(");
		expect(start).toBeGreaterThan(-1);
		return src.slice(start);
	}

	/** Every markup-bearing line, stripped of the differences that are allowed: the function's
	 * own name, indentation, and comments. What is left is the row itself. */
	function skeleton(src: string): string[] {
		return src
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l.startsWith("<") || l.startsWith("${") || l.includes('class="tp-'))
			.map((l) => l.replace(/\s+/g, " "));
	}

	it("renders the same markup for every state", () => {
		expect(skeleton(uiAliasRowSource())).toEqual(skeleton(contentAliasRowSource()));
	});

	it("keeps the same hooks the click handlers match on", () => {
		for (const src of [uiAliasRowSource(), contentAliasRowSource()]) {
			expect(src).toContain('data-tp-alias="1"');
			expect(src).toContain("tp-alias-busy");
			expect(src).toContain("tp-alias-error");
		}
	});
});
