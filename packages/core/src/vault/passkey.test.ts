import { describe, expect, it } from "vitest";
import type { Entry, PasskeyCredential } from "../hooks/useVault";
import { findPasskeys, planPasskeyPlacement } from "./passkey";

function passkey(over: Partial<PasskeyCredential> = {}): PasskeyCredential {
	return {
		credentialId: "cid",
		rpId: "github.com",
		userHandle: "dXNlcg",
		alg: -7,
		publicKeyCose: "pk",
		privateKey: "sk",
		signCount: 0,
		createdAt: 0,
		...over,
	};
}

const githubLogin: Entry = {
	id: "login-1",
	type: "login",
	name: "GitHub",
	urls: ["https://github.com/login"],
	username: "octocat",
	password: "pw",
};

describe("findPasskeys", () => {
	it("returns passkeys matching the rpId across login entries", () => {
		const entries: Entry[] = [
			{ ...githubLogin, passkeys: [passkey({ credentialId: "a" })] } as Entry,
			{
				id: "login-2",
				type: "login",
				name: "Example",
				urls: ["https://example.org"],
				username: "u",
				password: "p",
				passkeys: [passkey({ credentialId: "b", rpId: "example.org" })],
			} as Entry,
		];
		const matches = findPasskeys(entries, "github.com");
		expect(matches).toHaveLength(1);
		expect(matches[0]?.entryId).toBe("login-1");
		expect(matches[0]?.passkey.credentialId).toBe("a");
	});

	it("narrows to the allowCredentials list when provided", () => {
		const entries: Entry[] = [
			{
				...githubLogin,
				passkeys: [passkey({ credentialId: "a" }), passkey({ credentialId: "b" })],
			} as Entry,
		];
		expect(findPasskeys(entries, "github.com", ["b"]).map((m) => m.passkey.credentialId)).toEqual([
			"b",
		]);
		expect(findPasskeys(entries, "github.com", ["zzz"])).toHaveLength(0);
	});

	it("ignores non-login entries and logins without passkeys", () => {
		const entries: Entry[] = [githubLogin, { id: "n", type: "note", name: "secret" } as Entry];
		expect(findPasskeys(entries, "github.com")).toHaveLength(0);
	});
});

describe("planPasskeyPlacement", () => {
	it("attaches to a login already covering the rpId (host or subdomain)", () => {
		const entries: Entry[] = [githubLogin];
		const plan = planPasskeyPlacement(entries, "github.com", "GitHub", passkey());
		expect(plan.kind).toBe("attach");
		if (plan.kind === "attach") {
			expect(plan.entryId).toBe("login-1");
			expect(plan.passkeys).toHaveLength(1);
		}
	});

	it("matches a subdomain rpId against a stored parent-domain login", () => {
		const entries: Entry[] = [{ ...githubLogin, urls: ["https://accounts.github.com"] } as Entry];
		const plan = planPasskeyPlacement(entries, "github.com", undefined, passkey());
		expect(plan.kind).toBe("attach");
	});

	it("fabricates a standalone login when no entry covers the rpId", () => {
		const plan = planPasskeyPlacement(
			[],
			"example.org",
			"Example",
			passkey({ rpId: "example.org" }),
		);
		expect(plan.kind).toBe("create");
		if (plan.kind === "create") {
			expect(plan.data.name).toBe("Example");
			expect(plan.data.urls).toEqual(["https://example.org"]);
			expect(plan.data.passkeys).toHaveLength(1);
		}
	});

	it("names a standalone login after the rpId when rpName is blank", () => {
		const plan = planPasskeyPlacement([], "example.org", "  ", passkey({ rpId: "example.org" }));
		expect(plan.kind === "create" && plan.data.name).toBe("example.org");
	});
});
