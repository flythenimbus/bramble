import { describe, expect, it } from "vitest";
import { parseKeePass } from "./keepass";

/** No fixture here carries a passkey, so reaching the crypto bridge would itself be the bug. */
const noPasskeys = {
	passkeyImportPkcs8: () => Promise.reject(new Error("no passkey expected in this test")),
};

const XML = `<?xml version="1.0" encoding="utf-8"?>
<KeePassFile><Root>
  <Group><Name>Root</Name>
    <Entry>
      <String><Key>Title</Key><Value>GitHub</Value></String>
      <String><Key>UserName</Key><Value>octo</Value></String>
      <String><Key>Password</Key><Value ProtectInMemory="True">pw</Value></String>
      <String><Key>URL</Key><Value>https://github.com</Value></String>
      <String><Key>Notes</Key><Value>note</Value></String>
      <String><Key>otp</Key><Value>otpauth://t</Value></String>
      <String><Key>API Key</Key><Value ProtectInMemory="True">secret</Value></String>
      <History>
        <Entry><String><Key>Title</Key><Value>OLD REVISION</Value></String></Entry>
      </History>
    </Entry>
    <Group><Name>Recycle Bin</Name>
      <Entry><String><Key>Title</Key><Value>Deleted</Value></String></Entry>
    </Group>
  </Group>
</Root></KeePassFile>`;

describe("parseKeePass", () => {
	it("maps entries to logins, excludes History and Recycle Bin, and reads protected fields", async () => {
		const res = await parseKeePass(XML, noPasskeys);

		// History revision and Recycle Bin entry both excluded.
		expect(res.imported).toHaveLength(1);
		expect(res.byType).toEqual({ login: 1 });
		expect(res.imported[0]).toMatchObject({
			type: "login",
			name: "GitHub",
			username: "octo",
			password: "pw",
			urls: ["https://github.com"],
			notes: "note",
			totp: "otpauth://t",
		});
		// non-standard protected string → hidden custom field.
		expect(res.imported[0]?.customFields).toEqual([
			{ key: "API Key", value: "secret", hidden: true },
		]);
	});

	it("falls back to a bare TOTP Seed when there's no otp URI", async () => {
		const res = await parseKeePass(
			`<KeePassFile><Root><Group><Name>R</Name>
      <Entry>
        <String><Key>Title</Key><Value>X</Value></String>
        <String><Key>TOTP Seed</Key><Value>JBSWY3DPEHPK3PXP</Value></String>
      </Entry>
    </Group></Root></KeePassFile>`,
			noPasskeys,
		);
		expect(res.imported[0]).toMatchObject({ totp: "JBSWY3DPEHPK3PXP" });
	});

	it("rejects non-KeePass input", async () => {
		await expect(parseKeePass("<other/>", noPasskeys)).rejects.toThrow();
	});
});

const NESTED_XML = `<?xml version="1.0" encoding="utf-8"?>
<KeePassFile><Root>
  <Group><Name>MyDatabase</Name>
    <Group><Name>Work</Name>
      <Group><Name>Clients</Name>
        <Entry>
          <Tags>urgent,billing</Tags>
          <String><Key>Title</Key><Value>Acme</Value></String>
        </Entry>
      </Group>
    </Group>
  </Group>
</Root></KeePassFile>`;

describe("parseKeePass tags", () => {
	// Groups are the only organisation a KeePass database has, and they used to be
	// flattened away entirely. One tag per level, so an entry buried three deep is
	// findable by any folder above it.
	it("turns the group path into one tag per level, skipping the database root", async () => {
		const [entry] = (await parseKeePass(NESTED_XML, noPasskeys)).imported;
		expect(entry?.tags).toEqual(expect.arrayContaining(["Work", "Clients"]));
		expect(entry?.tags).not.toContain("MyDatabase");
	});

	it("reads KeePass's own comma-separated Tags element", async () => {
		const [entry] = (await parseKeePass(NESTED_XML, noPasskeys)).imported;
		expect(entry?.tags).toEqual(expect.arrayContaining(["urgent", "billing"]));
	});

	it("leaves tags off an entry in the root group with no Tags element", async () => {
		expect((await parseKeePass(XML, noPasskeys)).imported[0]?.tags).toBeUndefined();
	});

	// They are tags now, so they must not ALSO show up as custom fields.
	it("does not leak Tags or Group into custom fields", async () => {
		const [entry] = (await parseKeePass(NESTED_XML, noPasskeys)).imported;
		const keys = (entry?.customFields ?? []).map((f) => f.key);
		expect(keys).not.toContain("Tags");
		expect(keys).not.toContain("Group");
	});
});

// Issue #79. The parser runs with entity processing off to block expansion bombs, which also
// switches off the predefined entities, so these have to be decoded by hand.
describe("XML entity decoding", () => {
	const xml = (password: string, extra = "") => `<?xml version="1.0"?>
<KeePassFile><Root><Group><Name>Root</Name>
<Group><Name>${extra || "Folder"}</Name>
<Entry><String><Key>Title</Key><Value>Site</Value></String>
<String><Key>Password</Key><Value>${password}</Value></String></Entry>
</Group></Group></Root></KeePassFile>`;

	const passwordFrom = async (raw: string) =>
		((await parseKeePass(xml(raw), noPasskeys)).imported[0] as { password: string }).password;

	it("decodes the five predefined entities", async () => {
		expect(await passwordFrom("P@ssw&amp;rd123")).toBe("P@ssw&rd123");
		expect(await passwordFrom("admin&lt;root&gt;")).toBe("admin<root>");
		expect(await passwordFrom("&quot;hello&quot;")).toBe('"hello"');
		expect(await passwordFrom("it&apos;s")).toBe("it's");
	});

	it("decodes numeric character references, decimal and hex", async () => {
		expect(await passwordFrom("a&#38;b")).toBe("a&b");
		expect(await passwordFrom("a&#x26;b")).toBe("a&b");
		expect(await passwordFrom("&#128273;")).toBe("🔑"); // outside the BMP
	});

	it("does not double-decode", async () => {
		// The whole reason for one regex pass: sequential replaces would turn this into "<".
		expect(await passwordFrom("&amp;lt;")).toBe("&lt;");
		expect(await passwordFrom("&amp;amp;")).toBe("&amp;");
	});

	it("leaves anything that is not a known entity exactly as it was", async () => {
		expect(await passwordFrom("100% &raw; text")).toBe("100% &raw; text");
		expect(await passwordFrom("a & b")).toBe("a & b");
		expect(await passwordFrom("&#xD800;")).toBe("&#xD800;"); // lone surrogate
		expect(await passwordFrom("&#1114112;")).toBe("&#1114112;"); // past the last code point
	});

	it("decodes group names too, since they become tags", async () => {
		// normalizeTags slugifies the spaces; the point is the "&", which read "&amp;" before.
		const res = await parseKeePass(xml("pw", "Work &amp; Home"), noPasskeys);
		expect((res.imported[0] as { tags: string[] }).tags).toContain("Work-&-Home");
	});
});
