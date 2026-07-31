// A deliberate copy of content/template.ts, NOT an import of it.
//
// autofill-ui and content-script are separate rollup entries. A module imported by both is
// hoisted into a shared chunk, and the content script must bundle flat because it loads as a
// classic script (see vite.config.ts). Only autofill-ui imports this file, so it stays inlined.
//
// The copy is pinned against the original by content/template-parity.test.ts. These are
// escapers: if they drift, one entry gets an XSS hole the other doesn\'t, and nothing else in
// the build would notice. Fix BOTH copies, never merge them.

function escapeHtml(value: unknown): string {
	return String(value ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/** Tagged template that html-escapes scalar interpolations; arrays join verbatim. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): string {
	let out = strings[0] ?? "";
	for (let i = 0; i < values.length; i++) {
		const v = values[i];
		out += Array.isArray(v) ? v.join("") : escapeHtml(v);
		out += strings[i + 1] ?? "";
	}
	return out;
}
