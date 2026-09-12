// Opening the dev flag panel from somewhere that is not a keyboard.
//
// DevFlagsModal's shortcut is unreachable on a phone, and the panel is the only way to arm a
// store-review ask or flip a gate on a build you did not compile yourself. Settings -> About
// provides the touch way in; this carries the request across the tree, since the panel is mounted
// above every provider (App.tsx) and has no props from there.
//
// A registered function rather than a window event, matching ./android-back: the contract is a
// signature the compiler checks, not a string both ends have to spell the same way.

let opener: (() => void) | null = null;

/** Registered by the panel while it is mounted; null to clear. */
export function setDevFlagsOpener(fn: (() => void) | null): void {
	opener = fn;
}

/** Open the panel. False when nothing is listening, so a caller can stay quiet rather than
 * pretending it worked. */
export function openDevFlags(): boolean {
	if (!opener) return false;
	opener();
	return true;
}
