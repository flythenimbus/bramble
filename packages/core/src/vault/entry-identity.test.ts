import { describe, expect, it } from "vitest";
import type { Entry, EntryData } from "../hooks/useVault";
import { entryContentKey, splitAlreadyImported } from "./entry-identity";

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

	it("ignores usage metadata picked up after the import", () => {
		// breach is login-only, so build the login shape directly rather than spreading the union.
		const used = stored(login({ lastUsedAt: 1, breach: { leaked: true, checkedAt: 2 } }));
		expect(entryContentKey(used)).toBe(entryContentKey(login()));
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
			login({ name: "Reddit" }),
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
});
