import { i18n } from "@lingui/core";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { LoginEntryData, PasskeyCredential } from "../../hooks/useVault";
import { loginMode } from "./login";

// row() labels its copy actions through Lingui, which refuses to translate without an active
// locale. Empty catalog: each `msg` descriptor carries its source string as the fallback.
beforeAll(() => {
	i18n.loadAndActivate({ locale: "en", messages: {} });
});

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

describe("loginMode row copy items", () => {
	// The row's copy menu offers username, password, and (when there is one) the current
	// verification code. `row()` is memoized on the entry list in VaultHomeRoute, so a code
	// resolved when the row was projected would still be served minutes later, long past its
	// 30-second step. Hence the thunk, and hence this test.
	// row() takes a stored Entry (the data plus its id), not the bare form data.
	const asEntry = (data: LoginEntryData) => ({ ...data, id: "e1" });
	const withTotp = (totp: string) => asEntry({ ...base, totp });
	const items = (entry: ReturnType<typeof asEntry>) => loginMode.row(entry).copyItems;
	const labels = (entry: ReturnType<typeof asEntry>) => items(entry).map((i) => i.label);
	const find = (entry: ReturnType<typeof asEntry>, label: string) =>
		items(entry).find((i) => i.label === label);

	it("offers the verification code when the entry has an authenticator key", () => {
		expect(labels(withTotp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"))).toContain("verification code");
	});

	it("omits it when there is no key at all", () => {
		expect(labels(asEntry(base))).toEqual(["username", "password"]);
		expect(labels(withTotp(""))).toEqual(["username", "password"]);
	});

	it("omits it when the key can't generate codes, rather than offering a broken action", () => {
		// The detail view shows an "invalid key" state for these; the menu just stays quiet.
		expect(labels(withTotp("not-a-secret!!"))).toEqual(["username", "password"]);
	});

	it("generates the code on use, not when the row is built", () => {
		const item = find(withTotp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"), "verification code");
		expect(typeof item?.value).toBe("function");
		const resolve = item?.value as () => string;
		expect(resolve()).toMatch(/^\d{6}$/);
	});

	it("follows the clock, so a stale row still copies the current code", () => {
		const item = find(withTotp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"), "verification code");
		const resolve = item?.value as () => string;
		const spy = vi.spyOn(Date, "now");
		try {
			spy.mockReturnValue(59_000); // RFC 6238 vector time, SHA-1/6 digits
			const first = resolve();
			spy.mockReturnValue(1_111_111_109_000);
			const later = resolve();
			expect(first).not.toBe(later); // a captured string could not have changed
		} finally {
			spy.mockRestore();
		}
	});

	it("still offers username and password without a key", () => {
		expect(items(asEntry(base)).map((i) => i.value)).toEqual(["octocat", "pw"]);
	});
});
