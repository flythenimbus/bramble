import { createContext, type ReactNode, useCallback, useContext, useMemo, useRef } from "react";
import { usePlatform } from "../../context/PlatformContext";
import type { AppRouter } from "../router";

type DraftGetter = () => unknown;

interface PopOutContextValue {
	canPopOut: boolean;
	popOut: () => void;
	registerDraftGetter: (getter: DraftGetter | null) => void;
	takeInitialDraft: () => unknown;
}

const PopOutContext = createContext<PopOutContextValue | null>(null);

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

export function usePopOut(): PopOutContextValue {
	const ctx = useContext(PopOutContext);
	if (!ctx) throw new Error("usePopOut called outside PopOutProvider");
	return ctx;
}
