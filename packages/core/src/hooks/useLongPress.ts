// Touch long-press, for entering the vault list's selection mode on mobile.
// Pointer surfaces get a visible checkbox instead, so callers pass `enabled: false`
// there and the hook degrades to nothing but the plain click handler.

import { useCallback, useEffect, useRef } from "react";

const HOLD_MS = 450;
/** Past this much travel the gesture is a scroll, not a press. */
const MOVE_TOLERANCE_PX = 10;
/** How long to keep swallowing clicks after the press fires, if none arrives. */
const CLICK_GUARD_MS = 500;

export interface LongPressOptions {
	onLongPress: () => void;
	/** The normal tap action; skipped for the click that trails a long press. */
	onClick: () => void;
	/** False on pointer surfaces: only `onClick` is returned. */
	enabled: boolean;
}

/**
 * Spread the result onto the pressable element. The returned `onClick` swallows the
 * click the OS synthesizes when a long press is released, so the press doesn't also
 * fire the element's normal action.
 */
export function useLongPress({ onLongPress, onClick, enabled }: LongPressOptions) {
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const guard = useRef<ReturnType<typeof setTimeout> | null>(null);
	const origin = useRef<{ x: number; y: number } | null>(null);
	// Set when the press fires; makes the click the OS synthesizes on lift a no-op.
	const fired = useRef(false);

	const clearTimer = useCallback(() => {
		if (timer.current) clearTimeout(timer.current);
		timer.current = null;
	}, []);

	useEffect(() => {
		return () => {
			if (timer.current) clearTimeout(timer.current);
			if (guard.current) clearTimeout(guard.current);
		};
	}, []);

	if (!enabled) return { onClick };

	return {
		onClick: () => {
			if (fired.current) {
				fired.current = false;
				return;
			}
			onClick();
		},

		onTouchStart: (e: React.TouchEvent) => {
			const touch = e.touches[0];
			if (!touch || e.touches.length > 1) return;
			// A new press means any previous one is resolved; never let a stale guard
			// eat the next real tap.
			fired.current = false;
			if (guard.current) clearTimeout(guard.current);
			origin.current = { x: touch.clientX, y: touch.clientY };
			clearTimer();
			timer.current = setTimeout(() => {
				timer.current = null;
				fired.current = true;
				onLongPress();
			}, HOLD_MS);
		},

		onTouchMove: (e: React.TouchEvent) => {
			const touch = e.touches[0];
			if (!touch || !origin.current) return;
			const dx = touch.clientX - origin.current.x;
			const dy = touch.clientY - origin.current.y;
			if (Math.hypot(dx, dy) > MOVE_TOLERANCE_PX) clearTimer();
		},

		onTouchEnd: () => {
			clearTimer();
			// Release the guard on a timer too: not every platform follows the lift
			// with a click, and a stuck guard would swallow the user's next tap.
			if (fired.current) {
				if (guard.current) clearTimeout(guard.current);
				guard.current = setTimeout(() => {
					fired.current = false;
				}, CLICK_GUARD_MS);
			}
		},

		onTouchCancel: () => {
			clearTimer();
			fired.current = false;
		},

		// Suppresses the Android long-press context menu; iOS's callout is CSS
		// (`-webkit-touch-callout`, set in the mobile stylesheet).
		onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
	};
}
