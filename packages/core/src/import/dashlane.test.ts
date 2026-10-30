import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import type { CardEntryData, LoginEntryData, NoteEntryData } from "../hooks/useVault";
import { parseGooglePasswords } from "./csv";
import { parseDashlane } from "./dashlane";

// Headers as Dashlane writes them, from real exports in ProtonMail/WebClients and bitwarden/clients.
const CREDENTIALS = "username,username2,username3,title,password,note,url,category,otpUrl";
// Older exports carry the bare secret as `otpSecret`.
const CREDENTIALS_OLD = "username,username2,username3,title,password,note,url,category,otpSecret";
const NOTES = "title,note";
const PAYMENTS =
	"type,account_name,account_holder,cc_number,code,expiration_month,expiration_year,routing_number,account_number,country,issuing_bank,note,name";
// Older exports lack `note` and `name`, and call a card `credit_card` rather than `payment_card`.
const PAYMENTS_OLD =
	"type,account_name,account_holder,cc_number,code,expiration_month,expiration_year,routing_number,account_number,country,issuing_bank";
const IDS = "type,number,name,issue_date,expiration_date,place_of_issue,state";
const PERSONAL =
	"type,title,first_name,middle_name,last_name,login,date_of_birth,place_of_birth,email,email_type,item_name,phone_number,address,country,state,city,zip,address_recipient,address_building,address_apartment,address_floor,address_door_code,job_title,url";

type Row = Partial<Record<string, string>>;
const quote = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const csv = (header: string, ...rows: Row[]) => {
	const cols = header.split(",");
	return [header, ...rows.map((r) => cols.map((c) => quote(r[c] ?? "")).join(","))].join("\n");
};
const zip = (files: Record<string, string>): Uint8Array =>
	zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
/** A lone CSV, as the file picker hands it over: bytes. */
const bytes = (text: string) => strToU8(text);

const one = <T>(header: string, row: Row): T =>
	parseDashlane(bytes(csv(header, row))).imported[0] as T;
const fields = (e: { customFields?: { key: string; value: string; hidden?: boolean }[] }) =>
	e.customFields ?? [];

describe("the zip", () => {
	it("reads every CSV in it, logins first", () => {
		const result = parseDashlane(
			zip({
				"securenotes.csv": csv(NOTES, { title: "Wi-Fi", note: "Network: Sample-5G" }),
				"credentials.csv": csv(CREDENTIALS, {
					title: "GitHub",
					username: "octo",
					password: "123456",
				}),
				"payments.csv": csv(PAYMENTS, {
					type: "payment_card",
					account_name: "Jane Sample",
					cc_number: "4111111111111111",
				}),
				"ids.csv": csv(IDS, { type: "passport", number: "X123", name: "Jane Sample" }),
				"personalInfo.csv": csv(PERSONAL, {
					type: "email",
					item_name: "Email",
					email: "j@example.com",
				}),
			}),
		);
		expect(result.imported.map((e) => e.type)).toEqual(["login", "note", "card", "note", "note"]);
		expect(result.warnings).toEqual([]);
	});

	it("knows each file by its header, wherever it sits", () => {
		const result = parseDashlane(
			zip({ "export/renamed.csv": csv(CREDENTIALS, { title: "GitHub", password: "123456" }) }),
		);
		expect(result.imported).toHaveLength(1);
	});

	it("names a CSV it doesn't recognise instead of dropping it in silence", () => {
		const result = parseDashlane(
			zip({
				"credentials.csv": csv(CREDENTIALS, { title: "GitHub", password: "123456" }),
				"secrets.csv": "title,content\nKey,abc",
			}),
		);
		expect(result.imported).toHaveLength(1);
		expect(result.warnings).toContain(
			"secrets.csv isn't a Dashlane file Bramble knows, so it wasn't imported.",
		);
	});

	it("rejects a zip holding no Dashlane CSV", () => {
		expect(() => parseDashlane(zip({ "data.json": "{}" }))).toThrow(
			/doesn't look like a Dashlane export/,
		);
	});

	it("reports an archive it can't open", () => {
		const broken = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
		expect(() => parseDashlane(broken)).toThrow(/Couldn't read this Dashlane file/);
	});
});

describe("a lone CSV", () => {
	// Safari unzips downloads by default, so a Mac user may only have the loose files.
	it("imports one file of the export and points at the rest", () => {
		const result = parseDashlane(
			bytes(csv(CREDENTIALS, { title: "GitHub", username: "octo", password: "123456" })),
		);
		expect(result.imported).toHaveLength(1);
		expect(result.warnings).toContain(
			"This is one file of a Dashlane export. Import its other CSV files the same way, or choose the .zip.",
		);
	});

	it("names the format a mis-picked CSV really is", () => {
		const lastpass =
			"url,username,password,totp,extra,name,grouping,fav\nhttps://a.example,u,p,,,A,,0";
		expect(() => parseDashlane(bytes(lastpass))).toThrow(/looks like an export from LastPass/);
	});

	it("rejects a CSV it doesn't recognise", () => {
		expect(() => parseDashlane(bytes("a,b,c\n1,2,3"))).toThrow(
			/doesn't look like an export from Dashlane/,
		);
	});

	it("is named when given to another CSV card", () => {
		expect(() => parseGooglePasswords(csv(CREDENTIALS, { title: "GitHub" }))).toThrow(
			/looks like an export from Dashlane/,
		);
	});
});

describe("logins", () => {
	it("maps a credentials row", () => {
		const entry = one<LoginEntryData>(CREDENTIALS, {
			title: "GitHub",
			username: "octo",
			password: "123456",
			url: "https://github.com",
			note: "recovery codes are in the safe",
			category: "Dev",
			otpUrl: "otpauth://totp/?secret=JBSWY3DPEHPK3PXP&algorithm=SHA1&digits=6&period=30",
		});
		expect(entry).toMatchObject({
			type: "login",
			name: "GitHub",
			urls: ["https://github.com"],
			username: "octo",
			password: "123456",
			notes: "recovery codes are in the safe",
			totp: "otpauth://totp/?secret=JBSWY3DPEHPK3PXP&algorithm=SHA1&digits=6&period=30",
			tags: ["Dev"],
		});
		expect(fields(entry)).toEqual([]);
	});

	it("reads the older otpSecret column", () => {
		const entry = one<LoginEntryData>(CREDENTIALS_OLD, {
			title: "GitHub",
			password: "123456",
			otpSecret: "JBSWY3DPEHPK3PXP",
		});
		expect(entry.totp).toBe("JBSWY3DPEHPK3PXP");
	});

	it("keeps the second and third usernames as fields", () => {
		const entry = one<LoginEntryData>(CREDENTIALS, {
			title: "Shop",
			username: "jane",
			username2: "jane.sample@example.com",
			username3: "js",
			password: "123456",
		});
		expect(fields(entry)).toEqual([
			{ key: "Username 2", value: "jane.sample@example.com" },
			{ key: "Username 3", value: "js" },
		]);
	});

	it("falls back to the host for a login with no title", () => {
		const entry = one<LoginEntryData>(CREDENTIALS, {
			url: "https://site.example/login",
			password: "x",
		});
		expect(entry.name).toBe("site.example");
	});

	it("keeps a column it doesn't know as a field", () => {
		const entry = one<LoginEntryData>(`${CREDENTIALS},recovery`, {
			title: "GitHub",
			password: "123456",
			recovery: "abcd-efgh",
		});
		expect(fields(entry)).toEqual([{ key: "recovery", value: "abcd-efgh" }]);
	});

	it("says how many items had a category", () => {
		const result = parseDashlane(
			bytes(
				csv(
					CREDENTIALS,
					{ title: "A", password: "1", category: "Work" },
					{ title: "B", password: "2" },
				),
			),
		);
		expect(result.warnings).toContain("1 item(s) had a Dashlane category, imported as tags.");
	});

	it("makes each collection of an item its own tag", () => {
		// A real export lists an item in two collections comma-separated.
		const entry = one<LoginEntryData>(CREDENTIALS, {
			title: "A",
			password: "1",
			category: "Personal, Dev",
		});
		expect(entry.tags).toEqual(["Personal", "Dev"]);
	});
});

describe("secure notes", () => {
	it("maps a note", () => {
		const entry = one<NoteEntryData>(NOTES, { title: "Wi-Fi", note: "line 1\nline 2" });
		expect(entry).toMatchObject({ type: "note", name: "Wi-Fi", notes: "line 1\nline 2" });
	});

	it("reads the category a current export adds", () => {
		const entry = one<NoteEntryData>("title,note,category", {
			title: "Wi-Fi",
			note: "x",
			category: "Home",
		});
		expect(entry).toMatchObject({ type: "note", name: "Wi-Fi", tags: ["Home"] });
		expect(fields(entry)).toEqual([]);
	});
});

describe("payments", () => {
	it("maps a payment card", () => {
		const entry = one<CardEntryData>(PAYMENTS, {
			type: "payment_card",
			account_name: "Jane Sample",
			cc_number: "4111111111111111",
			code: "123",
			expiration_month: "03",
			expiration_year: "2029",
			country: "US",
			note: "the travel card",
			name: "My Visa",
		});
		expect(entry).toMatchObject({
			type: "card",
			name: "My Visa",
			cardholderName: "Jane Sample",
			number: "4111111111111111",
			brand: "Visa",
			cvv: "123",
			expMonth: "3",
			expYear: "2029",
			notes: "the travel card",
		});
		expect(fields(entry)).toEqual([{ key: "Country", value: "US" }]);
	});

	it("names an older credit_card row after its holder", () => {
		const entry = one<CardEntryData>(PAYMENTS_OLD, {
			type: "credit_card",
			account_name: "Jane Sample",
			cc_number: "5555555555554444",
			expiration_month: "01",
			expiration_year: "2030",
		});
		expect(entry).toMatchObject({ type: "card", name: "Jane Sample", brand: "Mastercard" });
	});

	it("keeps a bank account as a note with its details", () => {
		const entry = one<NoteEntryData>(PAYMENTS_OLD, {
			type: "bank",
			account_name: "Savings",
			account_holder: "Jane Sample",
			routing_number: "021000021",
			account_number: "000123456789",
			country: "US",
			issuing_bank: "US-ALLY",
		});
		expect(entry).toMatchObject({ type: "note", name: "Savings" });
		expect(fields(entry)).toEqual([
			{ key: "Account holder", value: "Jane Sample" },
			{ key: "Routing number", value: "021000021" },
			{ key: "Account number", value: "000123456789" },
			{ key: "Country", value: "US" },
			{ key: "Bank", value: "US-ALLY" },
		]);
	});
});

describe("IDs", () => {
	it("keeps a passport as a note with its details", () => {
		const entry = one<NoteEntryData>(IDS, {
			type: "passport",
			number: "X123",
			name: "Jane Sample",
			issue_date: "2022-1-30",
			expiration_date: "2032-1-30",
			place_of_issue: "Berlin",
		});
		expect(entry).toMatchObject({ type: "note", name: "Passport (Jane Sample)" });
		// Dashlane drops the leading zero from months and days.
		expect(fields(entry)).toEqual([
			{ key: "Number", value: "X123" },
			{ key: "Name", value: "Jane Sample" },
			{ key: "Issued", value: "2022-01-30" },
			{ key: "Expires", value: "2032-01-30" },
			{ key: "Place of issue", value: "Berlin" },
		]);
	});

	it("names an ID with no holder by its kind alone", () => {
		const entry = one<NoteEntryData>(IDS, { type: "tax_number", number: "123123123" });
		expect(entry.name).toBe("Tax number");
	});
});

describe("personal info", () => {
	it("names a name row after the person and keeps the rest as fields", () => {
		const entry = one<NoteEntryData>(PERSONAL, {
			type: "name",
			title: "MS",
			first_name: "Jane",
			last_name: "Sample",
			login: "jsample",
			date_of_birth: "1990-03-14",
		});
		expect(entry).toMatchObject({ type: "note", name: "Jane Sample" });
		expect(fields(entry)).toEqual([
			{ key: "Title", value: "MS" },
			{ key: "First name", value: "Jane" },
			{ key: "Last name", value: "Sample" },
			{ key: "Username", value: "jsample" },
			{ key: "Date of birth", value: "1990-03-14" },
		]);
	});

	it("names a row with no item name by its kind", () => {
		// A real export leaves `item_name` empty on an email row.
		const entry = one<NoteEntryData>(PERSONAL, {
			type: "email",
			email: "jane.sample@example.com",
			email_type: "personal",
		});
		expect(entry.name).toBe("Email");
	});

	it("names any other row by its item name", () => {
		const entry = one<NoteEntryData>(PERSONAL, {
			type: "address",
			item_name: "Home",
			address: "1 Sample Street",
			city: "Sampleton",
			zip: "12345",
			country: "US",
		});
		expect(entry).toMatchObject({ type: "note", name: "Home" });
		expect(fields(entry)).toEqual([
			{ key: "Address", value: "1 Sample Street" },
			{ key: "Country", value: "US" },
			{ key: "City", value: "Sampleton" },
			{ key: "Postcode", value: "12345" },
		]);
	});
});
