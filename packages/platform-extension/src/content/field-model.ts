// Caches the parsed PageFieldModel so the content cluster scans the DOM once per
// interaction instead of on every focus, keystroke, query, and fill. The
// MutationObserver invalidates the cache on any DOM change (see content.ts);
// reads also re-parse if a referenced field has left the document, so a stale
// element reference can't survive an SPA re-render. See CONTEXT.md.

import { type PageFieldModel, parsePageFields } from "./detection";

let cached: PageFieldModel | null = null;

/** Drop the cached model; the next getPageFields() re-parses. Wired to the MutationObserver. */
export function invalidatePageFields(): void {
	cached = null;
}

/**
 * The current page field model, parsed once and reused until invalidated by a
 * DOM mutation or until a referenced field leaves the document.
 */
export function getPageFields(): PageFieldModel {
	if (cached && !isStale(cached)) return cached;
	cached = parsePageFields();
	return cached;
}

/** Every non-null element the model references, for the staleness check. */
function referencedFields(m: PageFieldModel): HTMLInputElement[] {
	const els = [
		m.login.username,
		m.login.password,
		m.card.number,
		m.card.name,
		m.card.expCombined,
		m.card.expMonth,
		m.card.expYear,
		m.card.cvv,
		...m.otp,
	];
	return els.filter((el): el is HTMLInputElement => el !== null);
}

function isStale(m: PageFieldModel): boolean {
	return referencedFields(m).some((el) => !el.isConnected);
}
