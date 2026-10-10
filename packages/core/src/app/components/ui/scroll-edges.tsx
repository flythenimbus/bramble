import { useLingui } from "@lingui/react/macro";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { type RefObject, useEffect, useRef, useState } from "react";

export interface ScrollEdges {
	left: boolean;
	right: boolean;
}

/**
 * Tracks the hidden ends of a horizontal strip and supports a vertical mouse wheel.
 * A strip narrow enough to scroll otherwise just clips, with nothing to say the
 * rest is there.
 */
export function useScrollEdges<T extends HTMLElement>(): {
	ref: RefObject<T | null>;
	edges: ScrollEdges;
} {
	const ref = useRef<T>(null);
	const [edges, setEdges] = useState<ScrollEdges>({ left: false, right: false });
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const measure = () =>
			setEdges({
				left: el.scrollLeft > 1,
				right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1,
			});
		measure();
		const onWheel = (event: WheelEvent) => {
			if (event.defaultPrevented || !event.cancelable || event.ctrlKey || event.metaKey) {
				return;
			}
			// Keep horizontal and Shift-wheel gestures native inside the strip. The sibling
			// arrow overlays have no strip ancestor, so forward their gestures manually.
			if ((event.deltaX !== 0 || event.shiftKey) && event.composedPath().includes(el)) return;
			const delta = event.deltaX || event.deltaY;
			if (delta === 0) return;
			const maxScroll = el.scrollWidth - el.clientWidth;
			if (maxScroll <= 0) return;
			// Firefox and some mice report lines or pages rather than pixels.
			const unit =
				event.deltaMode === WheelEvent.DOM_DELTA_LINE
					? Number.parseFloat(getComputedStyle(el).lineHeight) || 16
					: event.deltaMode === WheelEvent.DOM_DELTA_PAGE
						? el.clientWidth
						: 1;
			const next = Math.max(0, Math.min(maxScroll, el.scrollLeft + delta * unit));
			// At either end, let the surrounding page continue scrolling normally.
			if (next === el.scrollLeft) return;
			event.preventDefault();
			el.scrollLeft = next;
		};
		el.addEventListener("scroll", measure, { passive: true });
		// React's delegated wheel listener is passive, so attach directly to cancel page scroll.
		// Include the edge buttons, which overlay the strip as siblings in the wrapper.
		const wheelTarget = el.parentElement ?? el;
		wheelTarget.addEventListener("wheel", onWheel, { passive: false });
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => {
			el.removeEventListener("scroll", measure);
			wheelTarget.removeEventListener("wheel", onWheel);
			ro.disconnect();
		};
	}, []);
	return { ref, edges };
}

/** The fade + scroll button over each hidden edge. The parent must be `relative`. */
export function ScrollEdgeFades({
	edges,
	scrollRef,
}: {
	edges: ScrollEdges;
	scrollRef: RefObject<HTMLElement | null>;
}) {
	const { t } = useLingui();
	const scroll = (direction: number) => {
		const el = scrollRef.current;
		if (!el) return;
		el.scrollBy({
			left: direction * el.clientWidth * 0.75,
			behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
		});
	};
	const buttonClass =
		"pointer-events-auto flex h-full w-8 shrink-0 cursor-pointer items-center justify-center rounded-sm text-foreground/80 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";
	return (
		<>
			{edges.left && (
				<div className="pointer-events-none absolute inset-y-0 left-0 flex w-12 items-center bg-gradient-to-r from-background via-background to-transparent">
					<button
						type="button"
						className={buttonClass}
						onClick={() => scroll(-1)}
						aria-label={t`Scroll left`}
						title={t`Scroll left`}
					>
						<ChevronLeft className="h-4 w-4" aria-hidden="true" />
					</button>
				</div>
			)}
			{edges.right && (
				<div className="pointer-events-none absolute inset-y-0 right-0 flex w-12 items-center justify-end bg-gradient-to-l from-background via-background to-transparent">
					<button
						type="button"
						className={buttonClass}
						onClick={() => scroll(1)}
						aria-label={t`Scroll right`}
						title={t`Scroll right`}
					>
						<ChevronRight className="h-4 w-4" aria-hidden="true" />
					</button>
				</div>
			)}
		</>
	);
}
