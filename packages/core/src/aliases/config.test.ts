import { describe, expect, it } from "vitest";
import { aliasConfigKeyFor, isAliasConfig, isAliasConfigKey } from "./config";
import { ALIAS_PROVIDERS, describeProvider, missingRequiredFields } from "./descriptors";

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

	// Every provider the settings screen can offer has to survive being read back. This guard was
	// a hand-written list of ids once, and a provider missing from it is not a type error and does
	// not throw: it silently rejects every saved config, so the feature just never appears.
	it.each(ALIAS_PROVIDERS.map((p) => p.id))("accepts a saved %s config", (provider) => {
		const options = Object.fromEntries(
			describeProvider(provider)
				.fields.filter((f) => f.required)
				.map((f) => [f.key, "x.example"]),
		);
		const apiKey = describeProvider(provider).needsApiKey ? { apiKey: "k" } : {};
		expect(isAliasConfig({ provider, options, ...apiKey })).toBe(true);
	});

	// Storage is not a trusted input: this may have been written by another build or edited.
	it.each([
		["not an object", null],
		["an unknown provider", { ...VALID, provider: "forwardemail" }],
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
		// Neither of these takes a domain, a format or anything else: their APIs accept no options
		// at all, so the screen shows the key field and nothing more.
		expect(describeProvider("duckduckgo").fields).toEqual([]);
		expect(describeProvider("relay").fields).toEqual([]);
		expect(missingRequiredFields("duckduckgo", {})).toEqual([]);
		expect(missingRequiredFields("relay", {})).toEqual([]);
		// Fastmail's address domain is the account's own Masked Email setting; the API takes none.
		expect(describeProvider("fastmail").fields).toEqual([]);
		expect(missingRequiredFields("fastmail", {})).toEqual([]);
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
