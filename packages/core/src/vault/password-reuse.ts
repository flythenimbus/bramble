// Which logins share a password with another. Local only: passwords are compared in memory
// and never leave the device (unlike the breach check, which sends a hash prefix).

import type { Entry } from "../hooks/useVault";

/** Ids of live logins whose password another live login also uses. Archived ones are out of use. */
export function reusedPasswordIds(entries: readonly Entry[]): Set<string> {
	const byPassword = new Map<string, string[]>();
	for (const e of entries) {
		if (e.type !== "login" || !e.password || e.archivedAt !== undefined) continue;
		const ids = byPassword.get(e.password);
		if (ids) ids.push(e.id);
		else byPassword.set(e.password, [e.id]);
	}
	const reused = new Set<string>();
	for (const ids of byPassword.values()) if (ids.length > 1) for (const id of ids) reused.add(id);
	return reused;
}
