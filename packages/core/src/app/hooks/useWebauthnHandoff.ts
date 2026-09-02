import { useCallback, useEffect, useRef } from "react";
import { useCan, usePlatform } from "../../context/PlatformContext";
import type { WebauthnKeyKind } from "../../vault/webauthn-ceremony";
import { usePopOut } from "./usePopOut";

/**
 * A ceremony deferred to the detached window. Firefox destroys its panel popup when the OS
 * passkey dialog takes focus, which aborts the ceremony before the dialog even renders, so on
 * that target the button hands the work over instead of running it. See webauthnNeedsWindow in
 * flags.ts and docs/security-keys.md.
 */
export type WebauthnHandoff =
	| { webauthn: "unlock" }
	| { webauthn: "register"; kind: WebauthnKeyKind; label: string };

function asHandoff(value: unknown): WebauthnHandoff | null {
	if (typeof value !== "object" || value === null) return null;
	const w = (value as { webauthn?: unknown }).webauthn;
	if (w === "unlock") return { webauthn: "unlock" };
	if (w !== "register") return null;
	const { kind, label } = value as { kind?: unknown; label?: unknown };
	if (kind !== "platform" && kind !== "securityKey") return null;
	return { webauthn: "register", kind, label: typeof label === "string" ? label : "" };
}

/**
 * Hands a WebAuthn ceremony to the detached window where the popup cannot host it, and resumes
 * one that was handed over. `onResume` fires at most once, in the detached window.
 *
 * The route travels with the handoff, so only one screen is ever mounted to receive it: the
 * unlock screen when locked, settings when not.
 *
 * `ready` holds the resume until the screen could actually service a click. The vault registry
 * loads asynchronously, and finishing an unlock records the active vault first, so resuming on a
 * bare mount sets it to null and the unwrap is refused with "vault locked". The draft is left
 * unconsumed until then, so nothing is lost by waiting.
 */
export function useWebauthnHandoff(
	onResume?: (intent: WebauthnHandoff) => void,
	ready = true,
): {
	/** True where the ceremony must not run here: it would be torn down mid-flight. */
	mustHandOff: boolean;
	/** Open the detached window and resume this ceremony there. */
	handOff: (intent: WebauthnHandoff) => void;
} {
	const needsWindow = useCan("webauthnNeedsWindow");
	const { shell } = usePlatform();
	const { popOut, takeInitialDraft } = usePopOut();
	// Only the attached popup is fatal. The detached window is a real window, and so is a tab.
	const mustHandOff = needsWindow && !shell.isDetached();

	const handOff = useCallback((intent: WebauthnHandoff) => popOut(intent), [popOut]);

	const resumed = useRef(false);
	useEffect(() => {
		if (resumed.current || !onResume || !ready) return;
		resumed.current = true;
		const intent = asHandoff(takeInitialDraft());
		if (intent) onResume(intent);
	}, [onResume, takeInitialDraft, ready]);

	return { mustHandOff, handOff };
}
