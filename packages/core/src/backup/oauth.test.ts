import { afterEach, describe, expect, it, vi } from "vitest";
import { bytesToBase64Url } from "../util/bytes";
import { exchangeCodeForTokens, generatePkce, refreshAccessToken } from "./oauth";

const DROPBOX_TOKEN = "https://api.dropboxapi.com/oauth2/token";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status });
}

describe("PKCE", () => {
	it("derives the challenge as the base64url S256 of the verifier; both are url-safe", async () => {
		const { verifier, challenge } = await generatePkce();
		expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
		const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
		expect(challenge).toBe(bytesToBase64Url(new Uint8Array(digest)));
	});

	it("generates a fresh verifier each call", async () => {
		const a = await generatePkce();
		const b = await generatePkce();
		expect(a.verifier).not.toBe(b.verifier);
	});
});

describe("exchangeCodeForTokens", () => {
	it("posts an authorization_code grant with the PKCE verifier + redirect and returns both tokens", async () => {
		const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
			jsonResponse({ access_token: "AT", refresh_token: "RT" }),
		);
		vi.stubGlobal("fetch", fetchMock);

		const tokens = await exchangeCodeForTokens({
			providerId: "dropbox",
			code: "CODE",
			codeVerifier: "VER",
			redirectUri: "https://ext.chromiumapp.org/",
		});
		expect(tokens).toEqual({ accessToken: "AT", refreshToken: "RT" });

		const [url, init] = fetchMock.mock.calls[0]!;
		expect(url).toBe(DROPBOX_TOKEN);
		expect(init?.method).toBe("POST");
		const body = init?.body as URLSearchParams;
		expect(body.get("grant_type")).toBe("authorization_code");
		expect(body.get("code")).toBe("CODE");
		expect(body.get("code_verifier")).toBe("VER");
		expect(body.get("redirect_uri")).toBe("https://ext.chromiumapp.org/");
		expect(body.get("client_id")).toBeTruthy();
	});

	it("throws when the provider omits a refresh token", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ access_token: "AT" })),
		);
		await expect(
			exchangeCodeForTokens({
				providerId: "dropbox",
				code: "c",
				codeVerifier: "v",
				redirectUri: "r",
			}),
		).rejects.toThrow(/refresh token/i);
	});

	it("throws on a non-2xx token response", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ error: "invalid_grant" }, 400)),
		);
		await expect(
			exchangeCodeForTokens({
				providerId: "dropbox",
				code: "c",
				codeVerifier: "v",
				redirectUri: "r",
			}),
		).rejects.toThrow(/400/);
	});
});

describe("refreshAccessToken", () => {
	it("posts a refresh_token grant and returns the fresh access token", async () => {
		const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
			jsonResponse({ access_token: "NEW" }),
		);
		vi.stubGlobal("fetch", fetchMock);

		expect(await refreshAccessToken("dropbox", "RT")).toBe("NEW");
		const body = fetchMock.mock.calls[0]![1]?.body as URLSearchParams;
		expect(body.get("grant_type")).toBe("refresh_token");
		expect(body.get("refresh_token")).toBe("RT");
		expect(body.get("client_id")).toBeTruthy();
	});

	it("throws (asking to reconnect) on a failed refresh", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ error: "expired_access_token" }, 401)),
		);
		await expect(refreshAccessToken("dropbox", "RT")).rejects.toThrow(/reconnect/i);
	});
});
