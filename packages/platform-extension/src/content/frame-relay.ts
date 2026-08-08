// Walks a picker's anchor rect up the frame tree so the top frame can host it: a
// hosted-fields card input sits in an iframe too short to draw a dropdown in.
// SECURITY: geometry and an opaque id only, never summaries or secrets - every hop
// is a page-readable message event. See docs/autofill.md.

import { deepQueryAll } from "./detection";

/** A rect in some frame's viewport coordinates. */
export interface RelayRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** An anchor that reached the top frame, `rect` in top-frame coords. */
export interface RelayedAnchor {
	relayId: string;
	rect: RelayRect;
}

export interface RelayHost {
	window: Window;
	document: Document;
}

const ANCHOR = "tp-relay-anchor";
const CLOSE = "tp-relay-close";

// Less room than this under the anchor and the dropdown gets clipped; relay instead.
export const MIN_PICKER_SPACE = 160;

// A relayed rect comes from a child frame, so it is clamped rather than trusted.
const MAX_COORD = 1_000_000;

type AnchorMessage = { __tp: typeof ANCHOR; relayId: string; rect: RelayRect };
type CloseMessage = { __tp: typeof CLOSE; relayId: string };

function finite(v: unknown): v is number {
	return typeof v === "number" && Number.isFinite(v);
}

function validRect(v: unknown): v is RelayRect {
	if (!v || typeof v !== "object") return false;
	const r = v as Record<string, unknown>;
	if (!finite(r.x) || !finite(r.y) || !finite(r.width) || !finite(r.height)) return false;
	if (r.width < 0 || r.height < 0) return false;
	return [r.x, r.y, r.width, r.height].every((n) => Math.abs(n as number) <= MAX_COORD);
}

function validRelayId(v: unknown): v is string {
	return typeof v === "string" && v.length > 0 && v.length <= 64;
}

function anchorMessage(v: unknown): AnchorMessage | null {
	if (!v || typeof v !== "object") return null;
	const m = v as Record<string, unknown>;
	if (m.__tp !== ANCHOR || !validRelayId(m.relayId) || !validRect(m.rect)) return null;
	return { __tp: ANCHOR, relayId: m.relayId, rect: m.rect };
}

function closeMessage(v: unknown): CloseMessage | null {
	if (!v || typeof v !== "object") return null;
	const m = v as Record<string, unknown>;
	if (m.__tp !== CLOSE || !validRelayId(m.relayId)) return null;
	return { __tp: CLOSE, relayId: m.relayId };
}

/** Numeric value of a computed length, or 0 when it isn't parseable. */
function px(value: string | undefined): number {
	const n = Number.parseFloat(value ?? "");
	return Number.isFinite(n) ? n : 0;
}

/** The frame element whose window is `source`: the hop's proof a real child sent it. */
function frameElementFor(doc: Document, source: MessageEventSource | null): HTMLElement | null {
	if (!source) return null;
	for (const el of deepQueryAll<HTMLIFrameElement | HTMLFrameElement>("iframe, frame", doc)) {
		if (el.contentWindow === source) return el;
	}
	return null;
}

/** Child rect -> this frame's coords. Border/padding count: the child's origin is the content box. */
function translate(rect: RelayRect, frameEl: HTMLElement, view: Window): RelayRect {
	const box = frameEl.getBoundingClientRect();
	const style = view.getComputedStyle?.(frameEl);
	const insetLeft = px(style?.borderLeftWidth) + px(style?.paddingLeft);
	const insetTop = px(style?.borderTopWidth) + px(style?.paddingTop);
	return {
		x: rect.x + box.left + insetLeft,
		y: rect.y + box.top + insetTop,
		width: rect.width,
		height: rect.height,
	};
}

export interface FrameRelay {
	isTop(): boolean;
	/** True when a picker anchored at `rect` would be clipped by this frame's viewport. */
	needsRelay(rect: RelayRect): boolean;
	/** Ask the ancestors to host a picker for `rect`, in this frame's coords. */
	open(relayId: string, rect: RelayRect): void;
	close(relayId: string): void;
	/** Top frame: a descendant wants a picker hosted here. */
	onAnchor(cb: (anchor: RelayedAnchor) => void): void;
	onClose(cb: (relayId: string) => void): void;
	dispose(): void;
}

/** Wire this frame into the relay chain. One instance per frame. */
export function installFrameRelay(host: RelayHost): FrameRelay {
	const { window: view, document: doc } = host;
	let anchorCb: ((anchor: RelayedAnchor) => void) | null = null;
	let closeCb: ((relayId: string) => void) | null = null;

	const isTop = (): boolean => view.parent === view;

	const postUp = (message: AnchorMessage | CloseMessage): void => {
		if (isTop()) return;
		// "*": ancestor origins are unknowable from here. Safe only for geometry.
		view.parent.postMessage(message, "*");
	};

	const onMessage = (e: MessageEvent): void => {
		const anchor = anchorMessage(e.data);
		const close = anchor ? null : closeMessage(e.data);
		if (!anchor && !close) return;
		// Drop anything that isn't from a real child frame (the page can post too).
		const frameEl = frameElementFor(doc, e.source);
		if (!frameEl) return;
		if (close) {
			if (isTop()) closeCb?.(close.relayId);
			else postUp(close);
			return;
		}
		if (!anchor) return;
		const rect = translate(anchor.rect, frameEl, view);
		if (isTop()) anchorCb?.({ relayId: anchor.relayId, rect });
		else postUp({ __tp: ANCHOR, relayId: anchor.relayId, rect });
	};

	view.addEventListener("message", onMessage);

	return {
		isTop,
		needsRelay(rect) {
			if (isTop()) return false;
			return view.innerHeight - (rect.y + rect.height) < MIN_PICKER_SPACE;
		},
		open(relayId, rect) {
			postUp({ __tp: ANCHOR, relayId, rect });
		},
		close(relayId) {
			postUp({ __tp: CLOSE, relayId });
		},
		onAnchor(cb) {
			anchorCb = cb;
		},
		onClose(cb) {
			closeCb = cb;
		},
		dispose() {
			view.removeEventListener("message", onMessage);
			anchorCb = null;
			closeCb = null;
		},
	};
}
