import { describe, expect, it } from "vitest";
import { aliasConfigKeyFor, isAliasConfig, isAliasConfigKey } from "./config";
import { describeProvider, missingRequiredFields } from "./descriptors";

// The key is held in the clear: this config is a synced pref, so it rides inside the vault's
// encrypted payload and is protected by the vault key like every entry. See docs/synced-settings.md.
const VALID = {
	provider: "addy",
	options: { domain: "anonaddy.me" },
	apiKey: "sk-live-xxxx",
};

describe("alias config storage", () => {
	// Vault-scoped: the key can spend an allowance and delete existing aliases, so it must not be
	// shared with a vault that was never given it. See CONTEXT.md.
	it("namespaces the key by vault id", () => {
		expect(aliasConfigKeyFor("v1")).toBe("alias.config:v1");
		expect(isAliasConfigKey(aliasConfigKeyFor("v1"))).toBe(true);
		expect(isAliasConfigKey("alias.config")).toBe(false);
	});

	it("accepts a well-formed config", () => {
		expect(isAliasConfig(VALID)).toBe(true);
		expect(isAliasConfig({ ...VALID, baseUrl: "https://addy.example.com" })).toBe(true);
	});

	// Storage is not a trusted input: this may have been written by another build or edited.
	it.each([
		["not an object", null],
		["an unknown provider", { ...VALID, provider: "fastmail" }],
		["a non-string baseUrl", { ...VALID, baseUrl: 5 }],
		["no options", { ...VALID, options: undefined }],
		["no api key", { ...VALID, apiKey: undefined }],
		["an empty api key", { ...VALID, apiKey: "" }],
		["a non-string api key", { ...VALID, apiKey: { iv: "aa" } }],
	])("rejects %s", (_why, value) => {
		expect(isAliasConfig(value)).toBe(false);
	});
});

describe("provider descriptors", () => {
	it("describes each provider's own settings without the caller switching on id", () => {
		expect(describeProvider("addy").fields.map((f) => f.key)).toEqual(["domain", "format"]);
		expect(describeProvider("simplelogin").fields.map((f) => f.key)).toEqual(["domain", "mode"]);
	});

	// Addy's domain list is only knowable from the account, which is what this marker means.
	it("marks Addy's domain as fetched from the account", () => {
		const domain = describeProvider("addy").fields.find((f) => f.key === "domain");
		expect(domain?.options).toBe("domains");
		expect(domain?.required).toBe(true);
	});

	it("names the required fields still missing, so a click is not spent finding out", () => {
		expect(missingRequiredFields("addy", {})).toEqual(["domain"]);
		expect(missingRequiredFields("addy", { domain: "anonaddy.me" })).toEqual([]);
		// SimpleLogin's domain is optional where Addy's is required: unset simply means the
		// account's default domain, which is a perfectly good answer.
		expect(missingRequiredFields("simplelogin", {})).toEqual([]);
	});
});
