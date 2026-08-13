import { ChevronLeft, ChevronRight } from "lucide-react";
import { type RefObject, useEffect, useRef, useState } from "react";

export interface ScrollEdges {
	left: boolean;
	right: boolean;
}

/**
 * Tracks which ends of a horizontal strip still have content scrolled past them.
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
		el.addEventListener("scroll", measure, { passive: true });
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => {
			el.removeEventListener("scroll", measure);
			ro.disconnect();
		};
	}, []);
	return { ref, edges };
}

/** The fade + chevron over each scrolled-past edge. The parent must be `relative`. */
export function ScrollEdgeFades({ edges }: { edges: ScrollEdges }) {
	return (
		<>
			{edges.left && (
				<div className="pointer-events-none absolute inset-y-0 left-0 flex w-12 items-center bg-gradient-to-r from-background via-background to-transparent">
					<ChevronLeft className="h-4 w-4 text-foreground/80" />
				</div>
			)}
			{edges.right && (
				<div className="pointer-events-none absolute inset-y-0 right-0 flex w-12 items-center justify-end bg-gradient-to-l from-background via-background to-transparent">
					<ChevronRight className="h-4 w-4 text-foreground/80" />
				</div>
			)}
		</>
	);
}
