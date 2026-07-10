// Best-effort macOS banner (with sound) fired right before an `age` decrypt that needs a
// YubiKey PIN + touch, so the short touch window isn't missed while you're looking away.
// No-op off macOS, and never throws: a failed notification must never break a release.
// See docs/release-signing.md.

import { execFileSync } from "node:child_process";

export function notifyYubiKeyTouch(reason: string): void {
	if (process.platform !== "darwin") return;
	// Strip quotes/backslashes so the reason can't break the AppleScript string literal.
	const body = `Touch your YubiKey to ${reason}.`.replace(/["\\]/g, "");
	try {
		execFileSync(
			"osascript",
			[
				"-e",
				`display notification "${body}" with title "Bramble release" subtitle "YubiKey" sound name "Submarine"`,
			],
			{ stdio: "ignore" },
		);
	} catch {
		// notifications are non-essential; ignore any failure.
	}
}
