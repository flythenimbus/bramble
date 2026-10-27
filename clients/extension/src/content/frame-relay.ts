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
// Down, not up: a click landed in an embedding page, so pickers in its frames should go.
const DISMISS = "tp-relay-dismiss";

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

/**
 * Child rect -> this frame's coords, kept inside the child's box, or null when it misses that box.
 * Border/padding count: the child's origin is the content box. The clamp is what stops a frame
 * from having the picker drawn anywhere on its embedder's page.
 */
function translate(rect: RelayRect, frameEl: HTMLElement, view: Window): RelayRect | null {
	const box = frameEl.getBoundingClientRect();
	const style = view.getComputedStyle?.(frameEl);
	const left = box.left + px(style?.borderLeftWidth) + px(style?.paddingLeft);
	const top = box.top + px(style?.borderTopWidth) + px(style?.paddingTop);
	const right = box.right - px(style?.borderRightWidth) - px(style?.paddingRight);
	const bottom = box.bottom - px(style?.borderBottomWidth) - px(style?.paddingBottom);
	const x = Math.max(rect.x + left, left);
	const y = Math.max(rect.y + top, top);
	const width = Math.min(rect.x + left + rect.width, right) - x;
	const height = Math.min(rect.y + top + rect.height, bottom) - y;
	if (width < 1 || height < 1) return null;
	return { x, y, width, height };
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
	/** Tell every child frame (and theirs) that the user clicked in this frame's page. */
	dismissDescendants(): void;
	/** A click landed in an ancestor's page. */
	onDismiss(cb: () => void): void;
	dispose(): void;
}

/** Wire this frame into the relay chain. One instance per frame. */
export function installFrameRelay(host: RelayHost): FrameRelay {
	const { window: view, document: doc } = host;
	let anchorCb: ((anchor: RelayedAnchor) => void) | null = null;
	let closeCb: ((relayId: string) => void) | null = null;
	let dismissCb: (() => void) | null = null;
	// Relay id -> the child frame element that opened it.
	const owners = new Map<string, HTMLElement>();

	const isTop = (): boolean => view.parent === view;

	const postUp = (message: AnchorMessage | CloseMessage): void => {
		if (isTop()) return;
		// "*": ancestor origins are unknowable from here. Safe only for geometry.
		view.parent.postMessage(message, "*");
	};

	// Carries nothing, so "*" is fine; a forged one only ever closes a picker.
	const dismissDescendants = (): void => {
		for (let i = 0; i < view.frames.length; i++) {
			try {
				view.frames[i]?.postMessage({ __tp: DISMISS }, "*");
			} catch {
				// A frame can go mid-loop.
			}
		}
	};

	const onMessage = (e: MessageEvent): void => {
		if ((e.data as { __tp?: unknown } | null)?.__tp === DISMISS) {
			if (isTop() || e.source !== view.parent) return;
			dismissCb?.();
			dismissDescendants();
			return;
		}
		const anchor = anchorMessage(e.data);
		const close = anchor ? null : closeMessage(e.data);
		if (!anchor && !close) return;
		// Drop anything that isn't from a real child frame (the page can post too).
		const frameEl = frameElementFor(doc, e.source);
		if (!frameEl) return;
		// The UI announces relay ids to every frame in the tab, so only the frame that opened a
		// relay may move or withdraw it.
		const relayId = (anchor ?? close)!.relayId;
		const owner = owners.get(relayId);
		if (owner && owner !== frameEl) return;
		if (close) {
			owners.delete(relayId);
			if (isTop()) closeCb?.(relayId);
			else postUp(close);
			return;
		}
		if (!anchor) return;
		const rect = translate(anchor.rect, frameEl, view);
		if (!rect) return;
		if (!owner) {
			for (const [id, el] of owners) if (!el.isConnected) owners.delete(id);
			owners.set(relayId, frameEl);
		}
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
		dismissDescendants,
		onDismiss(cb) {
			dismissCb = cb;
		},
		dispose() {
			view.removeEventListener("message", onMessage);
			anchorCb = null;
			closeCb = null;
			dismissCb = null;
		},
	};
}
