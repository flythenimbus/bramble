// EntryData -> KeePass String pairs, the inverse of import/keepass.ts `mapKeepassFields`.
//
// KeePass only models a login, so cards, notes and SSH keys are written as entries whose
// data lives in custom String fields (secrets marked Protected). Re-importing them yields a
// login carrying those fields, which is what the KDBX import path already does with any
// foreign database. Nothing is dropped; the type label is what KeePass can't carry.
//
// Tags are the exception to the String-pair rule: `Tags` is lifted by the Rust writer
// into KeePass's own `<Tags>` element (see TAGS_KEY in core-rust/src/kdbx.rs), so it
// round-trips as a real tag rather than a field that happens to be named one.
//
// Archived entries are exported alongside live ones with an `Archived` String field. The
// natural KeePass home for them would be the recycle-bin group, but this writer emits a
// flat entry list (`save_kdbx4` takes entries, not groups), and an archived entry is not
// deleted anyway. So the state rides as a field, on the same terms as the type label.

import type { KdbxSaveEntry } from "../adapters/crypto";
import type { EntryData } from "../hooks/useVault";

type Pair = { key: string; value: string; protected: boolean };

/**
 * Collects String pairs, dropping empties and keeping keys unique. Callers add the
 * type's own fields first and custom fields last, so a custom key that would shadow
 * one (a field literally named "Password") is the one that gets suffixed.
 */
class Fields {
	private readonly out: Pair[] = [];
	private readonly seen = new Set<string>();

	add(key: string, value: string | undefined, isProtected = false): void {
		if (!key || !value) return;
		this.out.push({ key: this.unique(key), value, protected: isProtected });
	}

	/** Two <String>s sharing a <Key> is malformed, and losing the value is worse. */
	private unique(key: string): string {
		if (!this.seen.has(key)) {
			this.seen.add(key);
			return key;
		}
		let n = 2;
		while (this.seen.has(`${key} (${n})`)) n++;
		const candidate = `${key} (${n})`;
		this.seen.add(candidate);
		return candidate;
	}

	done(): Pair[] {
		return this.out;
	}
}

/** KeePassXC reads a full `otpauth://` URI from `otp`; a bare base32 secret is the
 * KeeOtp `TOTP Seed` convention. Our own importer accepts either. */
function addTotp(f: Fields, totp: string): void {
	if (/^otpauth:\/\//i.test(totp.trim())) f.add("otp", totp, true);
	else f.add("TOTP Seed", totp, true);
}

function toFields(e: EntryData): Pair[] {
	const f = new Fields();
	f.add("Title", e.name);
	f.add("Notes", e.notes);
	// KeePass has a first-class Tags element and the Rust writer lifts this pair into it,
	// so tags land in a KeePass client's own tag column, not a custom field. Comma-joined
	// is KeePass's own separator.
	if (e.tags?.length) f.add("Tags", e.tags.join(","));
	// ISO 8601 rather than epoch ms: a human reading the field in KeePass should see a date.
	if (e.archivedAt !== undefined) f.add("Archived", new Date(e.archivedAt).toISOString());

	if (e.type === "login") {
		f.add("UserName", e.username);
		f.add("Password", e.password, true);
		// KeePass 2.x carries one URL per entry; the rest become numbered fields so a
		// multi-site credential doesn't quietly lose everything but the first.
		const [first, ...rest] = e.urls;
		f.add("URL", first);
		for (const [i, u] of rest.entries()) f.add(`URL ${i + 2}`, u);
		if (e.totp) addTotp(f, e.totp);
	} else if (e.type === "card") {
		f.add("Cardholder Name", e.cardholderName);
		f.add("Number", e.number, true);
		f.add("Brand", e.brand);
		f.add("Expiry Month", e.expMonth);
		f.add("Expiry Year", e.expYear);
		f.add("CVV", e.cvv, true);
	} else if (e.type === "ssh-key") {
		f.add("Key Type", e.keyType);
		f.add("Public Key", e.publicKey);
		f.add("Private Key", e.privateKey, true);
		f.add("Passphrase", e.passphrase, true);
	}

	for (const c of e.customFields ?? []) f.add(c.key, c.value, c.hidden === true);
	return f.done();
}

/** Map decrypted vault entries to the String pairs the KDBX writer expects. */
export function toKdbxEntries(entries: readonly EntryData[]): KdbxSaveEntry[] {
	return entries.map((e) => ({ strings: toFields(e) }));
}
