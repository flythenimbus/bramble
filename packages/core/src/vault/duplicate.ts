import type { Entry, EntryData } from "../hooks/useVault";

/**
 * A new entry seeded from an existing one (#212): what the user typed, not its history.
 * Passkeys stay behind, since a second copy of a private key is a cloned authenticator;
 * so do the password changelog, breach result, timestamps and sync stamps.
 */
export function duplicateEntry(entry: Entry, name: string): EntryData {
	const {
		id: _id,
		createdAt: _createdAt,
		updatedAt: _updatedAt,
		lastUsedAt: _lastUsedAt,
		archivedAt: _archivedAt,
		partStamps: _partStamps,
		itemStamps: _itemStamps,
		partStampsAt: _partStampsAt,
		...data
	} = entry;
	if (data.type === "login") {
		const { passkeys: _passkeys, passwordChangelog: _changelog, breach: _breach, ...login } = data;
		return { ...login, name };
	}
	return { ...data, name };
}
