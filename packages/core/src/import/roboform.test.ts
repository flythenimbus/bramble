import { describe, expect, it } from "vitest";
import type { LoginEntryData, NoteEntryData } from "../hooks/useVault";
import { parseGooglePasswords } from "./csv";
import { parseLastPass } from "./lastpass";
import { parseRoboForm } from "./roboform";

// The header the RoboForm extension and web app write. A real export starts with a BOM.
const HEADER = "﻿Name,Url,MatchUrl,Login,Pwd,Note,Folder,RfFieldsV2";
// The Windows desktop app writes `URL` and `Password` instead (bitwarden/clients#18403).
const WINDOWS_HEADER = "Name,URL,MatchUrl,Login,Password,Note,Folder,RfFieldsV2";

const csv = (...lines: string[]) => [HEADER, ...lines].join("\n");
const parse = (...lines: string[]) => parseRoboForm(csv(...lines));
const first = <T>(...lines: string[]): T => parse(...lines).imported[0] as T;
const fields = (e: { customFields?: { key: string; value: string; hidden?: boolean }[] }) =>
	e.customFields ?? [];

describe("logins", () => {
	it("maps a login row and its RoboForm fields", () => {
		// Shape copied from a real export: the fields column spills over into one cell per field.
		const entry = first<LoginEntryData>(
			'Asana,https://app.asana.com/-/login,https://app.asana.com/-/login,jane@example.com,123456,a note,,"User ID$,,,txt,jane@example.com","Password$,,,pwd,123456","another field,,,txt,test"',
		);
		expect(entry).toMatchObject({
			type: "login",
			name: "Asana",
			urls: ["https://app.asana.com/-/login"],
			username: "jane@example.com",
			password: "123456",
			notes: "a note",
		});
		// User ID$ and Password$ repeat the login's own columns, so only the extra field is kept.
		expect(fields(entry)).toEqual([{ key: "another field", value: "test" }]);
	});

	it("reads the TOTP key from the fields", () => {
		const entry = first<LoginEntryData>(
			'GitHub,https://github.com/login,https://github.com/login,octo,123456,,,"User ID$,,,txt,octo","Password$,,,pwd,123456","TOTP KEY$,,,txt,JBSWY3DPEHPK3PXP"',
		);
		expect(entry.totp).toBe("JBSWY3DPEHPK3PXP");
		expect(fields(entry)).toEqual([]);
	});

	it("masks a password-type field", () => {
		const entry = first<LoginEntryData>(
			'Bank,https://bank.example,https://bank.example,octo,123456,,,"PIN,,,pwd,0000"',
		);
		expect(fields(entry)).toEqual([{ key: "PIN", value: "0000", hidden: true }]);
	});

	it("keeps a field value holding commas whole", () => {
		const entry = first<LoginEntryData>(
			'Site,https://site.example,https://site.example,octo,123456,,,"Answer,,,txt,red, green, blue"',
		);
		expect(fields(entry)).toEqual([{ key: "Answer", value: "red, green, blue" }]);
	});

	it("keeps a second username or password that differs from the login's", () => {
		const entry = first<LoginEntryData>(
			'Site,https://site.example,https://site.example,octo,123456,,,"User ID$,,,txt,octo-alt","Password$,,,pwd,654321"',
		);
		expect(fields(entry)).toEqual([
			{ key: "Username", value: "octo-alt" },
			{ key: "Password", value: "654321", hidden: true },
		]);
	});

	it("names an unnamed field rather than dropping it", () => {
		const entry = first<LoginEntryData>(
			'Site,https://site.example,https://site.example,octo,123456,,,"-no-name-,,,txt,kept"',
		);
		expect(fields(entry)).toEqual([{ key: "Field", value: "kept" }]);
	});

	it("keeps a fields cell it cannot read, verbatim", () => {
		const entry = first<LoginEntryData>(
			"Site,https://site.example,https://site.example,octo,123456,,,not a field",
		);
		expect(fields(entry)).toEqual([{ key: "Field", value: "not a field" }]);
	});

	it("keeps both URLs when the match URL differs", () => {
		const entry = first<LoginEntryData>(
			"Site,https://site.example,https://login.site.example/signin,octo,123456,,",
		);
		expect(entry.urls).toEqual(["https://site.example", "https://login.site.example/signin"]);
	});

	it("undoes RoboForm's quote before a leading @ or '", () => {
		// RoboForm escapes a value starting with `@` or `'` by prepending a `'`.
		const entry = first<LoginEntryData>(
			"Site,https://site.example,https://site.example,'@octo,''123456,,,\"User ID$,,,txt,'@octo\",\"Password$,,,pwd,''123456\"",
		);
		expect(entry.username).toBe("@octo");
		expect(entry.password).toBe("'123456");
		expect(fields(entry)).toEqual([]);
	});

	it("undoes RoboForm's quote before a leading =, + or -", () => {
		// A real export writes the password `=hallo` as `'=hallo`, in the column and the field.
		const entry = first<LoginEntryData>(
			"Site,https://site.example,https://site.example,'+octo,'=hallo,,,\"Password$,,,pwd,'=hallo\",\"Answer,,,txt,'-1\"",
		);
		expect(entry.username).toBe("+octo");
		expect(entry.password).toBe("=hallo");
		expect(fields(entry)).toEqual([{ key: "Answer", value: "-1" }]);
	});

	it("leaves a quote before anything else alone", () => {
		const entry = first<LoginEntryData>("Site,https://site.example,,octo,'123456,,");
		expect(entry.password).toBe("'123456");
	});

	it("falls back to the host for a login with no name", () => {
		const entry = first<LoginEntryData>(",https://site.example/login,,octo,123456,,");
		expect(entry.name).toBe("site.example");
	});

	it("reads the Windows desktop app's header", () => {
		const entry = parseRoboForm(
			[WINDOWS_HEADER, "Site,https://site.example,https://site.example,octo,123456,,"].join("\n"),
		).imported[0] as LoginEntryData;
		expect(entry).toMatchObject({
			type: "login",
			urls: ["https://site.example"],
			username: "octo",
			password: "123456",
		});
	});
});

describe("safenotes and bookmarks", () => {
	it("imports a safenote row as a note", () => {
		// A real export writes a safenote with no fields column at all.
		const entry = first<NoteEntryData>("safe note,,,,,the body,");
		expect(entry).toMatchObject({ type: "note", name: "safe note", notes: "the body" });
	});

	it("imports a bookmark as a note holding its URL, not an empty login", () => {
		const entry = first<NoteEntryData>("Docs,https://docs.example,,,,read later,");
		expect(entry).toMatchObject({ type: "note", name: "Docs", notes: "read later" });
		expect(fields(entry)).toEqual([{ key: "URL", value: "https://docs.example" }]);
	});

	it("skips a row carrying nothing", () => {
		const result = parse(",,,,,,");
		expect(result.imported).toEqual([]);
		expect(result.skipped).toBe(1);
	});
});

describe("folders", () => {
	it("turns a folder path into one tag per level and says so", () => {
		const result = parse(
			"Note,,,,,body,/Work/Clients",
			"Other,https://site.example,https://site.example,octo,123456,,/another folder",
			"Loose,,,,,body,",
		);
		expect(result.imported.map((e) => e.tags)).toEqual([
			["Work", "Clients"],
			["another-folder"],
			undefined,
		]);
		expect(result.warnings).toContain("2 item(s) were in a RoboForm folder, imported as tags.");
	});
});

describe("the wrong file", () => {
	it("names the format it really is", () => {
		const lastpass =
			"url,username,password,totp,extra,name,grouping,fav\nhttps://a.example,u,p,,,A,,0";
		expect(() => parseRoboForm(lastpass)).toThrow(/looks like an export from LastPass/);
	});

	it("rejects a file it does not recognise", () => {
		expect(() => parseRoboForm("a,b,c\n1,2,3")).toThrow(
			/doesn't look like an export from RoboForm/,
		);
	});

	it("names RoboForm when its export is given to another CSV card", () => {
		expect(() => parseGooglePasswords(csv("Site,https://site.example,,octo,123456,,"))).toThrow(
			/looks like an export from RoboForm/,
		);
		expect(() => parseLastPass(csv("Site,https://site.example,,octo,123456,,"))).toThrow(
			/looks like an export from RoboForm/,
		);
	});
});
