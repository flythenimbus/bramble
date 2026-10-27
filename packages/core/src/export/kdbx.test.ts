import { describe, expect, it } from "vitest";
import type { EntryData } from "../hooks/useVault";
import { kdbxEntriesToResult } from "../import/kdbx";
import type { FileRecord } from "../sync";
import { fileRecord } from "../test/vault-fixtures";
import { toKdbxEntries, toKdbxExport } from "./kdbx";

/** No KeePass fixture here carries a passkey, so reaching the crypto bridge is itself a bug. */
const noPasskeys = {
	passkeyImportPkcs8: () => Promise.reject(new Error("no passkey expected in this test")),
};

/** Export then re-import through the real KDBX import path, which is what a user
 * moving a file between Bramble installs actually goes through. */
const roundTrip = async (e: EntryData): Promise<EntryData> => {
	const opened = { entries: toKdbxEntries([e]), attachments: [] };
	const [back] = (await kdbxEntriesToResult(opened, noPasskeys)).imported;
	if (!back) throw new Error("nothing re-imported");
	return back;
};

const fields = (e: EntryData) => {
	const [out] = toKdbxEntries([e]);
	if (!out) throw new Error("no entry");
	return out.strings;
};
const value = (e: EntryData, key: string) => fields(e).find((s) => s.key === key)?.value;
const isProtected = (e: EntryData, key: string) => fields(e).find((s) => s.key === key)?.protected;

const login = (over: Partial<Extract<EntryData, { type: "login" }>> = {}): EntryData => ({
	type: "login",
	name: "GitHub",
	urls: ["https://github.com"],
	username: "octocat",
	password: "pw",
	...over,
});

describe("toKdbxEntries: logins", () => {
	it("maps the standard KeePass fields and protects only the password", async () => {
		const e = login({ notes: "a note" });
		expect(value(e, "Title")).toBe("GitHub");
		expect(value(e, "UserName")).toBe("octocat");
		expect(value(e, "Password")).toBe("pw");
		expect(value(e, "URL")).toBe("https://github.com");
		expect(value(e, "Notes")).toBe("a note");
		expect(isProtected(e, "Password")).toBe(true);
		expect(isProtected(e, "Title")).toBe(false);
	});

	it("keeps extra URLs as numbered fields rather than dropping them", async () => {
		// KeePass 2.x has one URL per entry; a multi-site credential must not lose the rest.
		const e = login({ urls: ["https://a.com", "https://b.com", "https://c.com"] });
		expect(value(e, "URL")).toBe("https://a.com");
		expect(value(e, "URL 2")).toBe("https://b.com");
		expect(value(e, "URL 3")).toBe("https://c.com");
	});

	it("writes an otpauth URI to `otp` and a bare secret to `TOTP Seed`", async () => {
		const uri = login({ totp: "otpauth://totp/GitHub?secret=JBSWY3DPEHPK3PXP" });
		expect(value(uri, "otp")).toBe("otpauth://totp/GitHub?secret=JBSWY3DPEHPK3PXP");
		expect(value(uri, "TOTP Seed")).toBeUndefined();

		const bare = login({ totp: "JBSWY3DPEHPK3PXP" });
		expect(value(bare, "TOTP Seed")).toBe("JBSWY3DPEHPK3PXP");
		expect(value(bare, "otp")).toBeUndefined();
		expect(isProtected(bare, "TOTP Seed")).toBe(true);
	});

	it("omits fields with no value", async () => {
		const keys = fields(login({ urls: [] })).map((s) => s.key);
		expect(keys).not.toContain("URL");
		expect(keys).not.toContain("Notes");
	});
});

describe("toKdbxEntries: tags", () => {
	// Comma-joined into a single pair, which the Rust writer lifts into KeePass's own
	// <Tags> element so other clients read them as tags rather than a custom field.
	it("joins tags with commas, KeePass's own separator", async () => {
		expect(value(login({ tags: ["work", "bank"] }), "Tags")).toBe("work,bank");
	});

	it("leaves the pair off an untagged entry", async () => {
		expect(value(login(), "Tags")).toBeUndefined();
		expect(value(login({ tags: [] }), "Tags")).toBeUndefined();
	});

	it("is not protected: a tag is not a secret", async () => {
		expect(isProtected(login({ tags: ["work"] }), "Tags")).toBe(false);
	});

	it("round-trips back to tags rather than a custom field", async () => {
		const back = await roundTrip(login({ tags: ["work", "bank"] }));
		expect(back.tags).toEqual(["work", "bank"]);
		expect(back.customFields?.some((f) => f.key === "Tags")).toBeFalsy();
	});
});

describe("toKdbxEntries: archived entries", () => {
	// KeePass has no archived state and this writer emits a flat list, so the state rides
	// as a String field rather than a recycle-bin group. Exported, not dropped: a .kdbx is
	// a backup, and silently losing the archive would be worse than losing the label.
	it("writes an ISO date for an archived entry", async () => {
		expect(value(login({ archivedAt: Date.UTC(2026, 1, 3, 4, 5, 6) }), "Archived")).toBe(
			"2026-02-03T04:05:06.000Z",
		);
	});

	it("leaves the field off a live entry", async () => {
		expect(value(login(), "Archived")).toBeUndefined();
	});

	it("is not protected: it is a date, not a secret", async () => {
		expect(isProtected(login({ archivedAt: 1 }), "Archived")).toBe(false);
	});
});

describe("toKdbxEntries: non-login types", () => {
	it("writes card fields, protecting the number and CVV", async () => {
		const e: EntryData = {
			type: "card",
			name: "Personal Visa",
			cardholderName: "Jane Q. Doe",
			number: "4111111111111111",
			brand: "Visa",
			expMonth: "8",
			expYear: "2027",
			cvv: "123",
		};
		expect(value(e, "Title")).toBe("Personal Visa");
		expect(value(e, "Cardholder Name")).toBe("Jane Q. Doe");
		expect(value(e, "Number")).toBe("4111111111111111");
		expect(isProtected(e, "Number")).toBe(true);
		expect(isProtected(e, "CVV")).toBe(true);
		expect(isProtected(e, "Brand")).toBe(false);
	});

	it("writes SSH key fields, protecting the private key and passphrase", async () => {
		const e: EntryData = {
			type: "ssh-key",
			name: "Deploy key",
			publicKey: "ssh-ed25519 AAAA",
			privateKey: "-----BEGIN-----",
			passphrase: "secret",
			keyType: "ed25519",
		};
		expect(value(e, "Public Key")).toBe("ssh-ed25519 AAAA");
		expect(isProtected(e, "Private Key")).toBe(true);
		expect(isProtected(e, "Passphrase")).toBe(true);
		expect(isProtected(e, "Public Key")).toBe(false);
	});

	it("reduces a note to Title plus Notes", async () => {
		const e: EntryData = { type: "note", name: "Wi-Fi", notes: "SSID: Nimbus" };
		expect(fields(e).map((s) => s.key)).toEqual(["Title", "Notes"]);
	});
});

describe("toKdbxEntries: custom fields", () => {
	it("carries custom fields and maps hidden to protected", async () => {
		const e = login({
			customFields: [
				{ key: "Recovery email", value: "backup@example.com" },
				{ key: "PAT", value: "ghp_x", hidden: true },
			],
		});
		expect(value(e, "Recovery email")).toBe("backup@example.com");
		expect(isProtected(e, "PAT")).toBe(true);
		expect(isProtected(e, "Recovery email")).toBe(false);
	});

	it("suffixes a custom field that would shadow a standard KeePass key", async () => {
		// Two <String>s sharing a <Key> is malformed, and dropping the value is worse.
		const e = login({ customFields: [{ key: "Password", value: "not-the-real-one" }] });
		expect(value(e, "Password")).toBe("pw");
		expect(value(e, "Password (2)")).toBe("not-the-real-one");
		expect(fields(e).filter((s) => s.key === "Password")).toHaveLength(1);
	});

	it("keeps two identically-named custom fields distinct", async () => {
		const e = login({
			customFields: [
				{ key: "Note", value: "first" },
				{ key: "Note", value: "second" },
			],
		});
		expect(value(e, "Note")).toBe("first");
		expect(value(e, "Note (2)")).toBe("second");
	});
});

describe("export/import agree", () => {
	it("round-trips a login through the KeePass field mapper", async () => {
		const original = login({
			name: "GitHub",
			username: "octocat@example.com",
			password: "hunter2",
			urls: ["https://github.com"],
			notes: "Personal dev account.",
			totp: "otpauth://totp/GitHub?secret=JBSWY3DPEHPK3PXP",
			customFields: [{ key: "Recovery email", value: "backup@example.com" }],
		});

		const back = await roundTrip(original);

		expect(back).toMatchObject({
			type: "login",
			name: "GitHub",
			username: "octocat@example.com",
			password: "hunter2",
			urls: ["https://github.com"],
			notes: "Personal dev account.",
			totp: "otpauth://totp/GitHub?secret=JBSWY3DPEHPK3PXP",
		});
		expect(back.customFields).toEqual([{ key: "Recovery email", value: "backup@example.com" }]);
	});

	it("re-imports a card as a login carrying its fields (KeePass has no card type)", async () => {
		const card: EntryData = {
			type: "card",
			name: "Personal Visa",
			cardholderName: "Jane Q. Doe",
			number: "4111111111111111",
			expMonth: "8",
			expYear: "2027",
			cvv: "123",
		};

		const back = await roundTrip(card);

		expect(back.type).toBe("login");
		expect(back.name).toBe("Personal Visa");
		expect(back.customFields).toEqual(
			expect.arrayContaining([
				{ key: "Number", value: "4111111111111111", hidden: true },
				{ key: "CVV", value: "123", hidden: true },
			]),
		);
	});
});

describe("toKdbxExport", () => {
	const login = (id: string, name: string): EntryData & { id: string } => ({
		id,
		type: "login",
		name,
		urls: [],
		username: "u",
		password: "p",
	});
	/** Each record's sealed name, by id; "scan.pdf" for any not listed. */
	const named =
		(names: Record<string, string> = {}) =>
		async (record: FileRecord) => ({ name: names[record.id] ?? "scan.pdf", mime: "x/y" });

	it("puts each attachment on its own entry's index", async () => {
		const out = await toKdbxExport(
			[login("e1", "Passport"), login("e2", "Deed")],
			[fileRecord({ id: "f1", entryId: "e2" }), fileRecord({ id: "f2", entryId: "e1" })],
			"Attachments",
			named(),
		);
		expect(out.entries).toHaveLength(2);
		expect(out.files.map((f) => [f.record.id, f.entry])).toEqual([
			["f1", 1],
			["f2", 0],
		]);
	});

	// A file whose entry was deleted elsewhere is still the user's file: exported, not dropped.
	it("gathers attachments with no entry onto one extra entry", async () => {
		const out = await toKdbxExport(
			[login("e1", "Passport")],
			[
				fileRecord({ id: "f1", entryId: "gone" }),
				fileRecord({ id: "f2" }),
				fileRecord({ id: "f3", entryId: "e1" }),
			],
			"Attachments",
			named({ f1: "a.pdf", f2: "b.pdf" }),
		);
		expect(out.entries).toHaveLength(2);
		expect(out.entries[1]?.strings).toEqual([
			{ key: "Title", value: "Attachments", protected: false },
		]);
		expect(out.files.map((f) => f.entry)).toEqual([1, 1, 0]);
	});

	it("adds no extra entry when every attachment has one", async () => {
		const out = await toKdbxExport(
			[login("e1", "A")],
			[fileRecord({ entryId: "e1" })],
			"Attachments",
			named(),
		);
		expect(out.entries).toHaveLength(1);
	});

	// KeePass keys an entry's attachments by name, so two of one name on one entry would collide.
	it("names each attachment as sealed, made unique on its entry only", async () => {
		const out = await toKdbxExport(
			[login("e1", "A"), login("e2", "B")],
			[
				fileRecord({ id: "f1", entryId: "e1" }),
				fileRecord({ id: "f2", entryId: "e1" }),
				fileRecord({ id: "f3", entryId: "e1" }),
				fileRecord({ id: "f4", entryId: "e2" }),
				fileRecord({ id: "f5", entryId: "e1" }),
			],
			"Attachments",
			named({ f5: "README" }),
		);
		expect(out.files.map((f) => f.name)).toEqual([
			"scan.pdf",
			"scan (2).pdf",
			"scan (3).pdf",
			"scan.pdf",
			"README",
		]);
	});
});
