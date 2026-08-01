import { i18n } from "@lingui/core";
import { beforeAll, describe, expect, it } from "vitest";
import type { Entry, PasskeyCredential } from "../../../hooks/useVault";
import { toListItem } from "./list-item";

// The modes build copy-item labels through i18n, so a locale has to be active.
beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});

const passkey: PasskeyCredential = {
	credentialId: "AQID",
	rpId: "webauthn.io",
	userHandle: "AQID",
	alg: -7,
	publicKeyCose: "AQID",
	privateKey: "AQID",
	signCount: 0,
	createdAt: 1,
};

const login = (over: Partial<Extract<Entry, { type: "login" }>> = {}): Entry => ({
	id: "e1",
	type: "login",
	name: "webauthn.io",
	urls: ["https://webauthn.io"],
	username: "jane.doe@example.com",
	password: "pw",
	...over,
});

// The row component rendered the passkey marker correctly the whole time; this projection
// dropped the field before it got there, and a component test could not see that. Covering the
// seam rather than the leaf is the point.
describe("toListItem", () => {
	it("carries a mode's passkey count through to the row", () => {
		expect(toListItem(login({ passkeys: [passkey] }), true).passkeys).toBe(1);
	});

	it("reports zero for a login with none", () => {
		expect(toListItem(login(), true).passkeys).toBe(0);
	});

	it("leaves the field off entirely for a type that never has passkeys", () => {
		const note: Entry = { id: "n1", type: "note", name: "Recovery kit", notes: "…" };
		expect(toListItem(note, true).passkeys).toBeUndefined();
	});

	it("still hides the breach badge when breach checks are off", () => {
		const breached = login({ breach: { leaked: true, checkedAt: 1 } });
		expect(toListItem(breached, true).leaked).toBe(true);
		expect(toListItem(breached, false).leaked).toBe(false);
	});

	it("keeps the entry's own identity fields, not the mode's", () => {
		const item = toListItem(login({ name: "webauthn.io" }), true);
		expect(item).toMatchObject({ id: "e1", type: "login", name: "webauthn.io" });
	});

	it("folds custom fields into the search text", () => {
		const item = toListItem(login({ customFields: [{ key: "PIN", value: "1234" }] }), true);
		expect(item.searchText).toContain("pin");
	});
});
