import { createContext, type ReactNode, useCallback, useContext, useMemo, useRef } from "react";
import { useCan, usePlatform } from "../../context/PlatformContext";
import { useVaultRegistry } from "../../hooks/useVaultRegistry";
import type { AppRouter } from "../router";

/** Getter the active form route registers so pop-out can snapshot its in-flight draft. */
type DraftGetter = () => unknown;

/** Pop-out detaches the current route + form draft into a standalone window. */
interface PopOutContextValue {
	/** False when already detached (hides the affordance). */
	canPopOut: boolean;
	/** Snapshot the current route + form draft and open a detached window. Takes no argument, so
	 * it is safe as `onClick={popOut}`: React's click event cannot be sent to the background. */
	popOut: () => void;
	/** Open the window on this route handing over `draft` instead, e.g. a ceremony to resume (see
	 * webauthnNeedsWindow in flags.ts). */
	popOutWith: (draft: unknown) => void;
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
	const popOutCapable = useCan("popOut");
	// Which vault to reopen on. A locked selection is not persisted anywhere, so without this the
	// new window starts at the picker whenever more than one vault exists.
	const { activeId } = useVaultRegistry();
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

	const popOutWith = useCallback(
		(draft: unknown) => {
			const path = router.state.location.href;
			void shell.popOut({ path, draft, vaultId: activeId });
		},
		[router, shell, activeId],
	);
	const popOut = useCallback(() => popOutWith(draftGetterRef.current?.()), [popOutWith]);

	const value = useMemo<PopOutContextValue>(
		() => ({
			canPopOut: popOutCapable && !shell.isDetached(),
			popOut,
			popOutWith,
			registerDraftGetter,
			takeInitialDraft,
		}),
		[shell, popOutCapable, popOut, popOutWith, registerDraftGetter, takeInitialDraft],
	);

	return <PopOutContext.Provider value={value}>{children}</PopOutContext.Provider>;
}

/** Access pop-out controls. Throws outside PopOutProvider. */
export function usePopOut(): PopOutContextValue {
	const ctx = useContext(PopOutContext);
	if (!ctx) throw new Error("usePopOut called outside PopOutProvider");
	return ctx;
}
