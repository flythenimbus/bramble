import { describe, expect, it } from "vitest";
import type { LoginEntryData, PasskeyCredential } from "../../hooks/useVault";
import { loginMode } from "./login";

const passkey = (credentialId: string): PasskeyCredential => ({
	credentialId,
	rpId: "github.com",
	userHandle: "dXNlcg",
	userName: "octocat",
	alg: -7,
	publicKeyCose: "pk",
	privateKey: "sk",
	signCount: 0,
	createdAt: 0,
});

const base: LoginEntryData = {
	type: "login",
	name: "GitHub",
	urls: ["https://github.com"],
	username: "octocat",
	password: "pw",
	passkeys: [passkey("a"), passkey("b")],
};

describe("loginMode passkeys round-trip", () => {
	it("carries passkeys through toForm -> toEntry on an unrelated edit (no data loss)", () => {
		const form = loginMode.toForm(base);
		expect(form.passkeys).toHaveLength(2);
		form.password = "changed"; // edit something else, then save
		const entry = loginMode.toEntry(form) as LoginEntryData;
		expect(entry.password).toBe("changed");
		expect(entry.passkeys).toHaveLength(2);
	});

	it("drops a removed passkey, and omits the field when none remain", () => {
		const form = loginMode.toForm(base);
		form.passkeys = form.passkeys.filter((p: PasskeyCredential) => p.credentialId !== "a");
		expect((loginMode.toEntry(form) as LoginEntryData).passkeys).toEqual([passkey("b")]);
		form.passkeys = [];
		expect((loginMode.toEntry(form) as LoginEntryData).passkeys).toBeUndefined();
	});

	it("a login without passkeys stays undefined", () => {
		const form = loginMode.toForm({ ...base, passkeys: undefined });
		expect(form.passkeys).toEqual([]);
		expect((loginMode.toEntry(form) as LoginEntryData).passkeys).toBeUndefined();
	});
});
