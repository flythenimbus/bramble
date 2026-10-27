import { describe, expect, it } from "vitest";
import type { Entry, EntryData } from "../hooks/useVault";
import { entryContentKey, splitAlreadyImported } from "./entry-identity";
import { withPartStamps } from "./parts";

const login = (over: Partial<Extract<EntryData, { type: "login" }>> = {}): EntryData => ({
	type: "login",
	name: "GitHub",
	urls: ["https://github.com"],
	username: "octocat",
	password: "pw",
	...over,
});

/** What importMany writes: a fresh id, and updatedAt defaulted to the moment of import. */
const stored = (data: EntryData, at = 1_750_000_000_000): Entry =>
	({ id: crypto.randomUUID(), ...data, createdAt: at, updatedAt: at }) as Entry;

describe("entryContentKey", () => {
	it("ignores the id and stamps the vault adds, which is what makes re-import detectable", () => {
		expect(entryContentKey(stored(login()))).toBe(entryContentKey(login()));
	});

	// Every write records which write changed each part (docs/sync-conflicts.md, Phase B).
	it("ignores the part stamps every write records", () => {
		const hlc = { wall: 1_750_000_000_000, counter: 0, node: "device" };
		const written = withPartStamps(stored(login({ tags: ["work"] })), undefined, hlc);
		expect(written.partStampsAt).toEqual(hlc);
		expect(entryContentKey(written)).toBe(entryContentKey(login()));
	});

	it("ignores usage metadata picked up after the import", () => {
		// breach is login-only, so build the login shape directly rather than spreading the union.
		const used = stored(login({ lastUsedAt: 1, breach: { leaked: true, checkedAt: 2 } }));
		expect(entryContentKey(used)).toBe(entryContentKey(login()));
	});

	// Archiving is vault-local state no import file can carry, so an archived entry must
	// still match the file it came from; otherwise re-importing quietly duplicates it live.
	it("ignores the archived state", () => {
		expect(entryContentKey(stored(login({ archivedAt: 5000 })))).toBe(entryContentKey(login()));
	});

	// An import can seed tags, but they are curated locally afterwards. A hand-added tag
	// must not make the source file look like a brand-new entry on re-import.
	it("ignores tags", () => {
		expect(entryContentKey(stored(login({ tags: ["work"] })))).toBe(entryContentKey(login()));
	});

	// The cost of treating tags and archived state as metadata, stated plainly: an import
	// can ADD entries but can never UPDATE one that is already there. Re-importing a source
	// file whose entries have since been tagged or archived brings in nothing at all.
	it("treats a re-import carrying new tags/archived state as an entire duplicate", () => {
		const already = [stored(login())];
		const incoming = [login({ tags: ["work"] })];
		expect(splitAlreadyImported(already, incoming)).toMatchObject({
			fresh: [],
			duplicates: 1,
			likelyDuplicates: [],
			passwordDiffers: 0,
		});
	});

	it("survives key reordering, since stored entries are rebuilt on read", () => {
		const a = { type: "note", name: "x", notes: "y" } as EntryData;
		const b = { notes: "y", name: "x", type: "note" } as EntryData;
		expect(entryContentKey(a)).toBe(entryContentKey(b));
	});

	it("treats an absent field and an explicitly-undefined one as the same", () => {
		expect(entryContentKey({ ...login(), notes: undefined })).toBe(entryContentKey(login()));
	});

	it("separates entries that differ in any content field", () => {
		const base = entryContentKey(login());
		expect(entryContentKey(login({ password: "changed" }))).not.toBe(base);
		expect(entryContentKey(login({ username: "someone-else" }))).not.toBe(base);
		expect(entryContentKey(login({ name: "GitHub (work)" }))).not.toBe(base);
	});

	it("keeps array order significant", () => {
		expect(entryContentKey(login({ urls: ["https://a.com", "https://b.com"] }))).not.toBe(
			entryContentKey(login({ urls: ["https://b.com", "https://a.com"] })),
		);
	});

	it("strips nested stamps too: a passkey's own createdAt falls back to import time", () => {
		const passkey = (createdAt: number) => ({
			credentialId: "AQID",
			rpId: "github.com",
			userHandle: "AQID",
			alg: -7,
			publicKeyCose: "AQID",
			privateKey: "AQID",
			signCount: 0,
			createdAt,
		});
		expect(entryContentKey(login({ passkeys: [passkey(1)] }))).toBe(
			entryContentKey(login({ passkeys: [passkey(999_999)] })),
		);
	});

	it("still separates passkeys that differ in key material", () => {
		const pk = (privateKey: string) => ({
			credentialId: "AQID",
			rpId: "github.com",
			userHandle: "AQID",
			alg: -7,
			publicKeyCose: "AQID",
			privateKey,
			signCount: 0,
			createdAt: 1,
		});
		expect(entryContentKey(login({ passkeys: [pk("AAAA")] }))).not.toBe(
			entryContentKey(login({ passkeys: [pk("BBBB")] })),
		);
	});
});

describe("splitAlreadyImported", () => {
	it("drops entries the vault already holds", () => {
		const existing = [stored(login()), stored(login({ name: "Fastmail" }))];
		const { fresh, duplicates } = splitAlreadyImported(existing, [
			login(),
			login({ name: "Reddit", urls: ["https://reddit.com"] }),
		]);
		expect(duplicates).toBe(1);
		expect(fresh.map((e) => e.name)).toEqual(["Reddit"]);
	});

	it("collapses repeats inside the incoming batch as well", () => {
		const { fresh, duplicates } = splitAlreadyImported([], [login(), login(), login()]);
		expect(duplicates).toBe(2);
		expect(fresh).toHaveLength(1);
	});

	it("imports everything when the vault is empty", () => {
		const { fresh, duplicates } = splitAlreadyImported([], [login(), login({ name: "Other" })]);
		expect(duplicates).toBe(0);
		expect(fresh).toHaveLength(2);
	});

	it("re-importing a file after changing a password brings the new one in", () => {
		const existing = [stored(login())];
		const { fresh, duplicates } = splitAlreadyImported(existing, [login({ password: "rotated" })]);
		expect(duplicates).toBe(0);
		expect(fresh).toHaveLength(1);
	});

	// What rides on a duplicate (a KeePass entry's attachments) has to follow it somewhere.
	it("says what each duplicate matched: the vault's entry by id, or the copy kept", () => {
		const existing = { ...login(), id: "e1" };
		const twin = login({ name: "Twin", password: "other" });
		const again = login({ name: "Twin", password: "other" });
		const known = login();
		const { fresh, sameAs } = splitAlreadyImported([existing], [twin, known, again]);
		expect(fresh).toEqual([twin]);
		expect(sameAs.get(known)).toBe("e1");
		expect(sameAs.get(again)).toBe(twin);
		expect(sameAs.has(twin)).toBe(false);
	});
});

// The same login exported by a different manager never matches field for field: one export
// carries custom fields or extra URLs the other doesn't, so importing a second manager's file
// doubled the vault. Same site, username and password is the same login.
describe("splitAlreadyImported: the same login from another manager", () => {
	const card = (number: string): Extract<EntryData, { type: "card" }> => ({
		type: "card",
		name: "Visa",
		cardholderName: "Jane Doe",
		number,
		expMonth: "12",
		expYear: "2030",
		cvv: "123",
	});

	it("holds back a login matching on site, username and password whatever else differs", () => {
		const existing = [
			stored(
				login({
					customFields: [{ key: "PAT", value: "ghp_x", hidden: true }],
					notes: "dev account",
				}),
			),
		];
		const result = splitAlreadyImported(existing, [login({ name: "github.com", notes: "other" })]);
		expect(result.fresh).toEqual([]);
		expect(result.likelyDuplicates.map((e) => e.name)).toEqual(["github.com"]);
		expect(result.duplicates).toBe(0);
	});

	it("reads the site through www, a path or a missing scheme", () => {
		const existing = [stored(login({ urls: ["https://www.github.com/login?next=/"] }))];
		const { fresh, likelyDuplicates } = splitAlreadyImported(existing, [
			login({ urls: ["github.com"] }),
			login({ urls: ["https://GITHUB.com"], username: "octocat" }),
		]);
		expect(fresh).toEqual([]);
		expect(likelyDuplicates).toHaveLength(2);
	});

	it("compares usernames without case or surrounding spaces", () => {
		const existing = [stored(login({ username: "OctoCat@Example.com" }))];
		const { likelyDuplicates } = splitAlreadyImported(existing, [
			login({ username: "  octocat@example.com " }),
		]);
		expect(likelyDuplicates).toHaveLength(1);
	});

	it("imports a different password for the same site and username as new, and counts it", () => {
		const existing = [stored(login())];
		const result = splitAlreadyImported(existing, [login({ password: "older" })]);
		expect(result.fresh).toHaveLength(1);
		expect(result.likelyDuplicates).toEqual([]);
		expect(result.passwordDiffers).toBe(1);
	});

	it("treats another site or another username as a different login", () => {
		const existing = [stored(login())];
		const result = splitAlreadyImported(existing, [
			login({ urls: ["https://gitlab.com"] }),
			login({ username: "someone-else" }),
		]);
		expect(result.fresh).toHaveLength(2);
		expect(result.likelyDuplicates).toEqual([]);
		expect(result.passwordDiffers).toBe(0);
	});

	it("matches logins with no website on their title instead", () => {
		const existing = [stored(login({ urls: [], name: "Router admin" }))];
		const result = splitAlreadyImported(existing, [
			login({ urls: [], name: "router ADMIN" }),
			login({ urls: [], name: "NAS admin" }),
		]);
		expect(result.likelyDuplicates.map((e) => e.name)).toEqual(["router ADMIN"]);
		expect(result.fresh.map((e) => e.name)).toEqual(["NAS admin"]);
	});

	it("never matches on an empty password", () => {
		const existing = [stored(login({ password: "" }))];
		const { fresh, likelyDuplicates } = splitAlreadyImported(existing, [
			login({ password: "", notes: "passkey only" }),
		]);
		expect(likelyDuplicates).toEqual([]);
		expect(fresh).toHaveLength(1);
	});

	it("matches a login on the same app link", () => {
		const existing = [stored(login({ urls: ["androidapp://com.github.android"] }))];
		const { likelyDuplicates } = splitAlreadyImported(existing, [
			login({ urls: ["androidapp://com.github.android"], notes: "from the phone" }),
		]);
		expect(likelyDuplicates).toHaveLength(1);
	});

	it("does not take an app link for a website", () => {
		const existing = [stored(login({ urls: ["androidapp://com.github.android"] }))];
		const { fresh } = splitAlreadyImported(existing, [
			login({ urls: ["androidapp://com.example.other"] }),
		]);
		expect(fresh).toHaveLength(1);
	});

	it("matches a card on its number, however it is spaced", () => {
		const existing = [stored(card("4111 1111 1111 1111"))];
		const result = splitAlreadyImported(existing, [
			{ ...card("4111111111111111"), name: "Personal Visa", cvv: "" },
			card("5555 5555 5555 4444"),
		]);
		expect(result.likelyDuplicates.map((e) => e.name)).toEqual(["Personal Visa"]);
		expect(result.fresh).toHaveLength(1);
	});

	it("still drops exact duplicates outright rather than holding them back", () => {
		const existing = [stored(login())];
		const result = splitAlreadyImported(existing, [login()]);
		expect(result.duplicates).toBe(1);
		expect(result.likelyDuplicates).toEqual([]);
	});

	// A held-back entry's attachments join its look-alike unless it is imported after all.
	it("says which vault entry each held-back entry resembles", () => {
		const github = { ...stored(login()), id: "l1" };
		const visa = { ...stored(card("4111 1111 1111 1111")), id: "c1" };
		const sameLogin = login({ notes: "other" });
		const sameCard = { ...card("4111111111111111"), name: "Personal Visa" };
		const { likelyDuplicates, resembles } = splitAlreadyImported(
			[github, visa],
			[sameLogin, sameCard],
		);
		expect(likelyDuplicates).toEqual([sameLogin, sameCard]);
		expect(resembles.get(sameLogin)).toBe("l1");
		expect(resembles.get(sameCard)).toBe("c1");
	});
});
