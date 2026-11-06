// The password changelog: superseded passwords kept on a login so a rotation that
// hasn't propagated yet stays recoverable. See docs/password-changelog.md.
//
// This module is the ONLY writer of `passwordChangelog`. Every mutation routes its
// new entry through `withPasswordChangelog`, which derives the field from the entry
// on disk and discards whatever the caller supplied. That keeps the edit form (which
// rebuilds an entry from its own fields) from silently dropping the log, the way it
// would have to hand-carry it the way it hand-carries `passkeys`.

import type { Entry, EntryData, LoginEntryData, PasswordChange } from "../hooks/useVault";

/** Retained superseded passwords. Enough to cover a propagation lag, not a full audit trail. */
export const MAX_PASSWORD_CHANGELOG = 5;

/**
 * The changelog a login should carry after an edit: `prev`'s password prepended if
 * this edit replaced it, capped at MAX_PASSWORD_CHANGELOG. `undefined` when there is
 * nothing to keep, so entries without one carry no key.
 */
export function nextPasswordChangelog(
	prev: Entry | undefined,
	next: LoginEntryData,
	changedAt: number,
): PasswordChange[] | undefined {
	// A create, or a non-login becoming a login: no prior password to record.
	if (prev?.type !== "login") return undefined;
	const kept = prev.passwordChangelog ?? [];
	// An unchanged password (e.g. the breach-check write-back) must not log a row, and
	// neither must first-time entry of a password that was previously blank.
	if (prev.password === next.password || prev.password === "") {
		return kept.length > 0 ? kept : undefined;
	}
	return [{ value: prev.password, changedAt }, ...kept].slice(0, MAX_PASSWORD_CHANGELOG);
}

/**
 * Keep the log of a login moving between the user's own vaults, the one time a supplied value is
 * trusted: it came out of a vault they just unlocked, not an import file. Capped all the same.
 */
export function withCarriedPasswordChangelog(next: Entry, carried: EntryData): Entry {
	if (next.type !== "login" || carried.type !== "login" || !carried.passwordChangelog?.length) {
		return next;
	}
	return { ...next, passwordChangelog: carried.passwordChangelog.slice(0, MAX_PASSWORD_CHANGELOG) };
}

/**
 * Stamp the changelog onto an entry about to be persisted. Assigning the key even when
 * the result is `undefined` is deliberate: it strips a caller-supplied value, and
 * `JSON.stringify` drops the undefined key before it ever reaches the blob.
 */
export function withPasswordChangelog(
	next: Entry,
	prev: Entry | undefined,
	changedAt: number,
): Entry {
	if (next.type !== "login") return next;
	return { ...next, passwordChangelog: nextPasswordChangelog(prev, next, changedAt) };
}

/**
 * Fold the passwords of the versions a conflict resolution discards into the kept login's
 * changelog, with their own rows, so resolving can't lose a credential. Deduplicated by value
 * (newest kept), newest first, capped as usual; the kept password itself is never a row.
 */
export function withSupersededPasswords(
	entry: Entry,
	superseded: readonly EntryData[],
	changedAt: number,
): Entry {
	if (entry.type !== "login") return entry;
	const rows: PasswordChange[] = [...(entry.passwordChangelog ?? [])];
	for (const v of superseded) {
		if (v.type !== "login") continue;
		if (v.password) rows.push({ value: v.password, changedAt });
		rows.push(...(v.passwordChangelog ?? []));
	}
	const newest = new Map<string, PasswordChange>();
	for (const row of rows) {
		if (row.value === "" || row.value === entry.password) continue;
		const cur = newest.get(row.value);
		if (!cur || row.changedAt > cur.changedAt) newest.set(row.value, row);
	}
	const kept = [...newest.values()]
		.sort((a, b) => b.changedAt - a.changedAt)
		.slice(0, MAX_PASSWORD_CHANGELOG);
	return { ...entry, passwordChangelog: kept.length > 0 ? kept : undefined };
}
