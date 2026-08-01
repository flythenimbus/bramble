// The password changelog: superseded passwords kept on a login so a rotation that
// hasn't propagated yet stays recoverable. See docs/password-changelog.md.
//
// This module is the ONLY writer of `passwordChangelog`. Every mutation routes its
// new entry through `withPasswordChangelog`, which derives the field from the entry
// on disk and discards whatever the caller supplied. That keeps the edit form (which
// rebuilds an entry from its own fields) from silently dropping the log, the way it
// would have to hand-carry it the way it hand-carries `passkeys`.

import type { Entry, LoginEntryData, PasswordChange } from "../hooks/useVault";

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
