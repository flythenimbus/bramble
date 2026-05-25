import { describe, expect, it } from "vitest";
import { parseKeePass } from "./keepass";

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
	it("maps entries to logins, excludes History and Recycle Bin, and reads protected fields", () => {
		const res = parseKeePass(XML);

		// History revision and Recycle Bin entry both excluded.
		expect(res.imported).toHaveLength(1);
		expect(res.byType).toEqual({ login: 1 });
		expect(res.imported[0]).toMatchObject({
			type: "login",
			name: "GitHub",
			username: "octo",
			password: "pw",
			url: "https://github.com",
			notes: "note",
			totp: "otpauth://t",
		});
		// non-standard protected string → hidden custom field.
		expect(res.imported[0]?.customFields).toEqual([
			{ key: "API Key", value: "secret", hidden: true },
		]);
	});

	it("falls back to a bare TOTP Seed when there's no otp URI", () => {
		const res = parseKeePass(`<KeePassFile><Root><Group><Name>R</Name>
      <Entry>
        <String><Key>Title</Key><Value>X</Value></String>
        <String><Key>TOTP Seed</Key><Value>JBSWY3DPEHPK3PXP</Value></String>
      </Entry>
    </Group></Root></KeePassFile>`);
		expect(res.imported[0]).toMatchObject({ totp: "JBSWY3DPEHPK3PXP" });
	});

	it("rejects non-KeePass input", () => {
		expect(() => parseKeePass("<other/>")).toThrow();
	});
});
