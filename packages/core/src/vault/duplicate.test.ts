import { describe, expect, it } from "vitest";
import type { Entry } from "../hooks/useVault";
import { duplicateEntry } from "./duplicate";

const login = {
	id: "e1",
	type: "login",
	name: "Forum",
	urls: ["https://forum.test"],
	username: "jane",
	password: "pw",
	totp: "JBSWY3DPEHPK3PXP",
	tags: ["work"],
	customFields: [{ key: "PIN", value: "1234", hidden: true }],
	createdAt: 1,
	updatedAt: 2,
	lastUsedAt: 3,
	archivedAt: 4,
	breach: { leaked: false, checkedAt: 5 },
	passkeys: [{ credentialId: "AQID" }],
	passwordChangelog: [{ password: "old", changedAt: 1 }],
	partStamps: {},
	itemStamps: {},
	partStampsAt: "x",
} as unknown as Entry;

describe("duplicateEntry (#212)", () => {
	it("copies what the user typed, under the new name", () => {
		expect(duplicateEntry(login, "Forum (copy)")).toEqual({
			type: "login",
			name: "Forum (copy)",
			urls: ["https://forum.test"],
			username: "jane",
			password: "pw",
			totp: "JBSWY3DPEHPK3PXP",
			tags: ["work"],
			customFields: [{ key: "PIN", value: "1234", hidden: true }],
		});
	});
});
