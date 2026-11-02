// Anti-clickjacking for Bramble's page-level UI (the picker, the relayed picker, the passkey card):
// a host the page has hidden, faded, clipped, moved off screen or covered can't take a click.

/** A click this soon after the UI appeared may have been aimed at whatever was there before. */
export const EARLY_CLICK_MS = 500;

/** Product of the `opacity()` functions in a computed filter (1 when there are none). */
function filterOpacity(filter: string): number {
	let out = 1;
	for (const m of filter.matchAll(/opacity\(\s*([\d.]+)(%?)\s*\)/g)) {
		out *= Number(m[1]) / (m[2] ? 100 : 1);
	}
	return out;
}

/** The opacity `el` is painted at: neither `opacity` nor `filter` inherits, so an ancestor's
 * never shows in the element's own computed style. Other ancestor filters are allowed (Dark
 * Reader's filter mode inverts every page's root). */
function effectiveOpacity(el: Element): number {
	let out = 1;
	for (let node: Element | null = el; node; node = node.parentElement) {
		const cs = getComputedStyle(node);
		const own = Number.parseFloat(cs.opacity);
		out *= (Number.isNaN(own) ? 1 : own) * filterOpacity(cs.filter ?? "");
	}
	return out;
}

/** Whether `host` is on screen, near-opaque, unfiltered, unclipped and topmost at its centre. */
export function isLegible(host: HTMLElement): boolean {
	const rect = host.getBoundingClientRect();
	if (rect.width < 60 || rect.height < 20) return false;
	if (
		rect.bottom <= 0 ||
		rect.right <= 0 ||
		rect.top >= window.innerHeight ||
		rect.left >= window.innerWidth
	) {
		return false;
	}
	const cs = getComputedStyle(host);
	if (cs.visibility !== "visible" || cs.display === "none") return false;
	if (effectiveOpacity(host) < 0.9) return false;
	if (cs.filter !== "none" || cs.mixBlendMode !== "normal" || cs.clipPath !== "none") return false;
	// elementFromPoint resolves to the host (closed shadow); an unrelated element means an overlay.
	const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
	if (!top) return false;
	return top === host || host.contains(top) || top.contains(host);
}
