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
import { html as uiHtml } from "../autofill-ui-template";
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
