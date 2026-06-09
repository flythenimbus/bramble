import { createContext, type ReactNode, useCallback, useContext, useMemo, useRef } from "react";
import { usePlatform } from "../../context/PlatformContext";
import type { AppRouter } from "../router";

/** Getter the active form route registers so pop-out can snapshot its in-flight draft. */
type DraftGetter = () => unknown;

/** Pop-out detaches the current route + form draft into a standalone window. */
interface PopOutContextValue {
	/** False when already detached (hides the affordance). */
	canPopOut: boolean;
	/** Snapshot the current route + draft and open a detached window. */
	popOut: () => void;
	/** Active form route registers its draft getter on mount, null on unmount. */
	registerDraftGetter: (getter: DraftGetter | null) => void;
	/** Returns the draft this window opened with, exactly once (undefined after). */
	takeInitialDraft: () => unknown;
}

const PopOutContext = createContext<PopOutContextValue | null>(null);

/** Provides pop-out context; seeded with the handed-over draft when this is a detached window. */
export function PopOutProvider({
	router,
	initialDraft,
	children,
}: {
	router: AppRouter;
	initialDraft?: unknown;
	children: ReactNode;
}) {
	const { shell } = usePlatform();
	const draftGetterRef = useRef<DraftGetter | null>(null);
	const initialDraftRef = useRef<unknown>(initialDraft);

	const registerDraftGetter = useCallback((getter: DraftGetter | null) => {
		draftGetterRef.current = getter;
	}, []);

	const takeInitialDraft = useCallback(() => {
		const draft = initialDraftRef.current;
		initialDraftRef.current = undefined;
		return draft;
	}, []);

	const popOut = useCallback(() => {
		const path = router.state.location.href;
		const draft = draftGetterRef.current?.();
		void shell.popOut({ path, draft });
	}, [router, shell]);

	const value = useMemo<PopOutContextValue>(
		() => ({ canPopOut: !shell.isDetached(), popOut, registerDraftGetter, takeInitialDraft }),
		[shell, popOut, registerDraftGetter, takeInitialDraft],
	);

	return <PopOutContext.Provider value={value}>{children}</PopOutContext.Provider>;
}

/** Access pop-out controls. Throws outside PopOutProvider. */
export function usePopOut(): PopOutContextValue {
	const ctx = useContext(PopOutContext);
	if (!ctx) throw new Error("usePopOut called outside PopOutProvider");
	return ctx;
}
