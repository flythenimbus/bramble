// When the unlock screen may present the biometric gate on its own (issue #43), kept off the
// component so the rules are unit-testable. See docs/auth-and-unlock.md.

export interface AutoPromptState {
	/** The user opted in (prefs.biometricAutoPrompt). Off by default. */
	enabled: boolean;
	/** The gate is set up for this vault and usable now (the manual button is showing). */
	offered: boolean;
	/** The last lock was the Lock button, not an auto-lock. */
	lockedByUser: boolean;
	/** The screen is on screen, as far as document visibility knows. */
	visible: boolean;
	/** The OS reports the app foreground-active, where the shell can tell (mobile). */
	appActive: boolean;
	/** This screen already fired its one shot. */
	attempted: boolean;
}

/**
 * Three gates for "not while off screen", because painting is not the same as being able to
 * present system UI. Auto-lock fires as the app leaves the foreground, so this screen routinely
 * mounts backgrounded. `visible` is the cheap check; the caller also waits on a frame, which a
 * hidden document cannot produce; and `appActive` is the OS's own answer, which on iOS arrives
 * more than a second after the webview starts painting.
 */
export function shouldAutoPromptBiometric(state: AutoPromptState): boolean {
	if (!state.enabled || !state.offered) return false;
	if (state.lockedByUser || state.attempted) return false;
	return state.visible && state.appActive;
}
