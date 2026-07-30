import { i18n } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";
import type { ImportResult } from "../../../../import";
import { getEntryMode } from "../../../entry-modes";

// .tsx, not .ts: the Lingui macro transform only covers .tsx, and a macro in a .ts file
// silently interpolates without ever being extracted or translated.

/**
 * Pluralized "3 Logins · 1 Payment card · 2 passkeys" summary.
 *
 * Passkeys are counted separately because they ride INSIDE logins, so a transfer that
 * brought five of them would otherwise read as plain "1 Login" and give the user no way to
 * see whether the part they care about arrived.
 */
export function countLine(result: ImportResult): string {
	const parts = Object.entries(result.byType).map(([type, n]) => {
		const label = getEntryMode(type).label;
		return `${n} ${label}${n === 1 ? "" : "s"}`;
	});
	const passkeys = result.imported.reduce(
		(n, e) => n + (e.type === "login" ? (e.passkeys?.length ?? 0) : 0),
		0,
	);
	if (passkeys > 0) parts.push(plural(passkeys, { one: "# passkey", other: "# passkeys" }));
	return parts.join(" · ") || i18n._(msg`Nothing to import`);
}
