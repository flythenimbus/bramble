import { describe, expect, it } from "vitest";
import type { CardEntryData, LoginEntryData, SshKeyEntryData } from "../hooks/useVault";
import { parseGooglePasswords } from "./csv";
import { parseLastPass } from "./lastpass";

const HEADER = "url,username,password,totp,extra,name,grouping,fav";
const LEGACY_HEADER = "url,username,password,extra,name,grouping,fav";
const csv = (...rows: string[]) => [HEADER, ...rows].join("\n");

/** Wrap a typed secure note's `extra` block as the CSV field it arrives in. */
const note = (block: string, name: string, grouping = "") =>
	`http://sn,,,,"${block.replace(/"/g, '""')}",${name},${grouping},0`;

const first = <T>(raw: string): T => parseLastPass(raw).imported[0] as T;
const fields = (e: { customFields?: { key: string; value: string }[] }) =>
	Object.fromEntries((e.customFields ?? []).map((f) => [f.key, f.value]));

describe("logins", () => {
	it("maps every column", () => {
		const entry = first<LoginEntryData>(
			csv("https://github.com/login,alice,secret,JBSWY3DPEHPK3PXP,a note,GitHub,Dev,0"),
		);
		expect(entry).toMatchObject({
			type: "login",
			name: "GitHub",
			notes: "a note",
			urls: ["https://github.com/login"],
			username: "alice",
			password: "secret",
			totp: "JBSWY3DPEHPK3PXP",
		});
	});

	it("passes a full otpauth:// URI through verbatim", () => {
		const entry = first<LoginEntryData>(
			csv("https://x.example,a,b,otpauth://totp/x?secret=ABC,,X,,0"),
		);
		expect(entry.totp).toBe("otpauth://totp/x?secret=ABC");
	});

	it("reads the pre-TOTP header, where the columns sit one to the left", () => {
		const entry = first<LoginEntryData>(
			[LEGACY_HEADER, "https://x.example,alice,secret,a note,X,Dev,0"].join("\n"),
		);
		expect(entry).toMatchObject({ username: "alice", password: "secret", notes: "a note" });
		expect(entry.totp).toBeUndefined();
	});

	it("treats the bare http:// placeholder as no URL", () => {
		expect(first<LoginEntryData>(csv("http://,alice,secret,,,Router,,0")).urls).toEqual([]);
		expect(first<LoginEntryData>(csv(",alice,secret,,,Legacy,,0")).urls).toEqual([]);
	});

	it("falls back to the host, then the username, for a nameless row", () => {
		expect(first<LoginEntryData>(csv("https://forum.example.org/x,lurker,p,,,,,0")).name).toBe(
			"forum.example.org",
		);
		expect(first<LoginEntryData>(csv("http://,lurker,p,,,,,0")).name).toBe("lurker");
	});

	it("keeps a password holding commas, quotes and backslashes", () => {
		const entry = first<LoginEntryData>(
			csv('https://x.example,build,"p@ss,w""rd\\with\\slashes",,,Jenkins,,0'),
		);
		expect(entry.password).toBe('p@ss,w"rd\\with\\slashes');
	});

	it("skips a row carrying nothing at all", () => {
		const res = parseLastPass(csv(",,,,,,,0"));
		expect(res.imported).toEqual([]);
		expect(res.skipped).toBe(1);
	});
});

describe("secure notes", () => {
	it("maps an untyped note body", () => {
		const entry = first<{ type: string; name: string; notes?: string }>(
			csv("http://sn,,,,So secure,My Note,,0"),
		);
		expect(entry).toMatchObject({ type: "note", name: "My Note", notes: "So secure" });
	});

	it("keeps a multi-line body with escaped quotes", () => {
		const entry = first<{ notes?: string }>(
			csv('http://sn,,,,"He said ""hello"".\nSecond line.",Quoted,,0'),
		);
		expect(entry.notes).toBe('He said "hello".\nSecond line.');
	});

	it("folds a typed note's fields into custom fields, in template order", () => {
		const entry = first<{ type: string; customFields?: { key: string }[] }>(
			csv(
				note(
					"NoteType:Bank Account\nLanguage:en-GB\nBank Name:Example Bank\nAccount Type:Checking\nRouting Number:\nAccount Number:12345\nSWIFT Code:\nIBAN Number:\nPin:4321\nBranch Address:\nBranch Phone:\nNotes:Joint",
					"Current Account",
				),
			),
		);
		expect(entry.type).toBe("note");
		// Empty template fields are dropped; `Language` never becomes a field.
		expect((entry.customFields ?? []).map((f) => f.key)).toEqual([
			"Bank Name",
			"Account Type",
			"Account Number",
			"Pin",
		]);
	});

	it("masks a field that holds a secret", () => {
		const entry = first<{ customFields?: { key: string; hidden?: boolean }[] }>(
			csv(note("NoteType:Server\nLanguage:en-US\nHostname:h\nUsername:u\nPassword:p\nNotes:", "S")),
		);
		expect(entry.customFields).toContainEqual({ key: "Password", value: "p", hidden: true });
		expect(entry.customFields).toContainEqual({ key: "Hostname", value: "h" });
	});

	it("reads a user-defined Custom_ type, whose field names are unknowable", () => {
		const entry = first<{ notes?: string; customFields?: { key: string }[] }>(
			csv(
				note(
					'NoteType:Custom_657088934083173965\nLanguage:en-US\ntext field:some value\nmy password:custompass\ndate:January,31,2001\nNotes:First line with a quote "\nSecond line',
					"Custom Item",
				),
			),
		);
		expect((entry.customFields ?? []).map((f) => f.key)).toEqual([
			"text field",
			"my password",
			"date",
		]);
		// `Notes:` runs to the end of the block, so the unprefixed line belongs to it.
		expect(entry.notes).toBe('First line with a quote "\nSecond line');
	});

	it("keeps a value holding colons and commas", () => {
		const entry = first<{ customFields?: { key: string; value: string }[] }>(
			csv(
				note(
					'NoteType:Address\nLanguage:en-GB\nTitle:mrs\nFirst Name:Zoë\nMiddle Name:\nLast Name:\nUsername:\nGender:\nBirthday:August,23,1990\nCompany:\nAddress 1:\nAddress 2:\nAddress 3:\nCity / Town:\nCounty:\nState:\nZip / Postal Code:\nCountry:\nTimezone:+01:00,1\nEmail Address:\nPhone:{"num":"48404505606","ext":"11"}\nEvening Phone:\nMobile Phone:\nFax:\nNotes:',
					"Zoë",
				),
			),
		);
		expect(fields(entry)).toMatchObject({
			Birthday: "August,23,1990",
			Timezone: "+01:00,1",
			Phone: '{"num":"48404505606","ext":"11"}',
		});
	});
});

describe("credit cards", () => {
	const card = (language: string, type: string, number: string, expiry: string, start = "") =>
		note(
			`NoteType:Credit Card\nLanguage:${language}\nName on Card:Alice\nType:${type}\nNumber:${number}\nSecurity Code:123\nStart Date:${start}\nExpiration Date:${expiry}\nNotes:`,
			"Card",
		);

	it("turns the English month name into digits and keeps a four-digit year", () => {
		const entry = first<CardEntryData>(
			csv(card("en-US", "Visa", "4111111111111111", "November,2030")),
		);
		expect(entry).toMatchObject({
			type: "card",
			cardholderName: "Alice",
			brand: "Visa",
			expMonth: "11",
			expYear: "2030",
			cvv: "123",
		});
	});

	it("keeps a two-digit year as-is, which CardExpYearSchema accepts", () => {
		const entry = first<CardEntryData>(csv(card("", "CC", "1234123412341234", "April,29")));
		expect(entry).toMatchObject({ expMonth: "4", expYear: "29" });
	});

	it("derives the brand from the number, not the free-text Type", () => {
		const entry = first<CardEntryData>(csv(card("en-GB", "CC", "5555555555554444", "June,2028")));
		expect(entry.brand).toBe("Mastercard");
		// The number supplied the brand, so `Type` is a separate thing the user typed: keep it.
		expect(fields(entry).Type).toBe("CC");
	});

	it("does not repeat a Type that itself named the brand", () => {
		const entry = first<CardEntryData>(csv(card("en-GB", "Visa", "1234123412341234", "June,2028")));
		expect(entry.brand).toBe("Visa");
		expect(fields(entry).Type).toBeUndefined();
	});

	it("leaves the brand unset when neither the number nor the Type names one", () => {
		const entry = first<CardEntryData>(csv(card("", "CC", "1234123412341234", "April,29")));
		expect(entry.brand).toBeUndefined();
		expect(fields(entry).Type).toBe("CC");
	});

	it("drops a Start Date written as bare commas, and a garbage expiry", () => {
		const entry = first<CardEntryData>(csv(card("en-GB", "Visa", "4111111111111111", "", ",")));
		expect(fields(entry)["Start Date"]).toBeUndefined();
		expect(entry).toMatchObject({ expMonth: "", expYear: "" });
	});
});

describe("SSH keys", () => {
	it("reads a private key whose PEM spans several lines", () => {
		const pem =
			"-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAA\n-----END OPENSSH PRIVATE KEY-----";
		const entry = first<SshKeyEntryData>(
			csv(
				note(
					`NoteType:SSH Key\nLanguage:en-US\nBit Strength:4096\nFormat:PEM\nPassphrase:keypass\nPrivate Key:${pem}\nPublic Key:ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFake alice@example.com\nHostname:ssh.example.com\nDate:January,31,2024\nNotes:Deploy key`,
					"Deploy Key",
				),
			),
		);
		expect(entry).toMatchObject({
			type: "ssh-key",
			privateKey: pem,
			passphrase: "keypass",
			keyType: "ed25519",
			notes: "Deploy key",
		});
		expect(fields(entry)).toMatchObject({ "Bit Strength": "4096", Hostname: "ssh.example.com" });
	});

	it("stays a note when the type says SSH Key but no key came across", () => {
		const entry = first<{ type: string }>(
			csv(
				note(
					"NoteType:SSH Key\nLanguage:en-US\nBit Strength:1\nFormat:\nPassphrase:\nPrivate Key:\nPublic Key:\nHostname:\nDate:\nNotes:",
					"Empty",
				),
			),
		);
		expect(entry.type).toBe("note");
	});
});

describe("folders", () => {
	it("keeps the folder path as a field and says it did", () => {
		const res = parseLastPass(csv("https://x.example,a,b,,,X,Dev\\Hosting,0"));
		expect(fields(res.imported[0] as LoginEntryData).Folder).toBe("Dev\\Hosting");
		expect(res.warnings).toEqual([
			'1 item(s) were in a LastPass folder, kept as a "Folder" field because Bramble has no folders yet.',
		]);
	});

	it("says nothing when no entry was in a folder", () => {
		expect(parseLastPass(csv("https://x.example,a,b,,,X,,0")).warnings).toEqual([]);
	});
});

describe("wrong file", () => {
	it("names Google when handed a Google export", () => {
		const google = "name,url,username,password,note\nX,https://x.example,a,b,c";
		expect(() => parseLastPass(google)).toThrow(/export from Google Password Manager/);
	});

	it("names LastPass when a LastPass export is handed to the Google card", () => {
		// Regression: LastPass carries name+url+username+password too, so Google's headers alone
		// used to accept the file and drop its notes, TOTP and folders in silence.
		expect(() => parseGooglePasswords(csv("http://sn,,,,body,N,,0"))).toThrow(
			/export from LastPass/,
		);
	});

	it("complains plainly about a file it cannot place", () => {
		expect(() => parseLastPass("a,b,c\n1,2,3")).toThrow(
			/doesn't look like an export from LastPass/,
		);
	});
});
