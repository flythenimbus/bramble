import { bytesToBase64, bytesToBase64Url } from "@core/util/bytes";
import { describe, expect, it } from "vitest";
import {
	authenticationResponseJSON,
	COSE_ES256,
	parseCreationOptions,
	parseRequestOptions,
	registrationResponseJSON,
} from "../background/webauthn-json";
import {
	buildCreateCredential,
	buildGetCredential,
	serializeCreateOptions,
	serializeGetOptions,
} from "./webauthn-inpage-codec";

const u8 = (...n: number[]) => new Uint8Array(n);
const bufBytes = (b: ArrayBuffer) => Array.from(new Uint8Array(b));

describe("serializeCreateOptions -> parseCreationOptions (options the background reads)", () => {
	it("round-trips the fields the ceremony needs, base64url-encoded", () => {
		const challenge = u8(9, 8, 7, 6);
		const userId = u8(1, 2, 3);
		const excludeId = u8(4, 4, 4);
		const opts = {
			rp: { id: "example.com", name: "Example" },
			user: { id: userId, name: "alice", displayName: "Alice" },
			challenge,
			pubKeyCredParams: [{ type: "public-key", alg: COSE_ES256 }],
			excludeCredentials: [{ type: "public-key", id: excludeId }],
			authenticatorSelection: { userVerification: "required" },
		} as unknown as PublicKeyCredentialCreationOptions;

		const parsed = parseCreationOptions(JSON.stringify(serializeCreateOptions(opts)));

		expect(parsed.rpId).toBe("example.com");
		expect(parsed.rpName).toBe("Example");
		expect(parsed.userName).toBe("alice");
		expect(parsed.userDisplayName).toBe("Alice");
		expect(parsed.userHandleB64Url).toBe(bytesToBase64Url(userId));
		expect(parsed.challenge).toBe(bytesToBase64Url(challenge));
		expect(parsed.algs).toEqual([COSE_ES256]);
		expect(parsed.excludeCredentialsB64Url).toEqual([bytesToBase64Url(excludeId)]);
		expect(parsed.userVerification).toBe("required");
	});
});

describe("serializeGetOptions -> parseRequestOptions", () => {
	it("round-trips rpId, challenge, allowCredentials, userVerification", () => {
		const challenge = u8(5, 5, 5, 5);
		const allowId = u8(7, 7);
		const opts = {
			challenge,
			rpId: "example.com",
			allowCredentials: [{ type: "public-key", id: allowId }],
			userVerification: "preferred",
		} as unknown as PublicKeyCredentialRequestOptions;

		const parsed = parseRequestOptions(JSON.stringify(serializeGetOptions(opts)));

		expect(parsed.rpId).toBe("example.com");
		expect(parsed.challenge).toBe(bytesToBase64Url(challenge));
		expect(parsed.allowCredentialsB64Url).toEqual([bytesToBase64Url(allowId)]);
		expect(parsed.userVerification).toBe("preferred");
	});
});

describe("buildCreateCredential (RegistrationResponseJSON -> synthetic PublicKeyCredential)", () => {
	it("materializes real ArrayBuffers and the attestation getters", () => {
		const credId = u8(1, 1, 1);
		const attObj = u8(2, 2, 2, 2);
		const authData = u8(3, 3);
		const pubKey = u8(4, 4, 4, 4, 4);
		// The background emits base64url in this JSON; the codec must decode it back to bytes.
		const json = registrationResponseJSON({
			credentialIdStdB64: bytesToBase64(credId),
			attestationObjectStdB64: bytesToBase64(attObj),
			authenticatorDataStdB64: bytesToBase64(authData),
			publicKeyStdB64: bytesToBase64(pubKey),
			clientDataB64Url: bytesToBase64Url(u8(123, 125)), // "{}"
		});

		const cred = buildCreateCredential(JSON.parse(json));

		expect(cred.type).toBe("public-key");
		expect(cred.rawId).toBeInstanceOf(ArrayBuffer);
		expect(bufBytes(cred.rawId)).toEqual([...credId]);
		const r = cred.response as AuthenticatorAttestationResponse;
		expect(bufBytes(r.attestationObject)).toEqual([...attObj]);
		expect(bufBytes(r.getAuthenticatorData())).toEqual([...authData]);
		expect(bufBytes(r.getPublicKey() as ArrayBuffer)).toEqual([...pubKey]);
		expect(r.getPublicKeyAlgorithm()).toBe(COSE_ES256);
		expect(r.getTransports()).toEqual(["internal", "hybrid"]);
		expect(cred.getClientExtensionResults()).toEqual({});
	});
});

describe("buildGetCredential (AuthenticationResponseJSON -> synthetic PublicKeyCredential)", () => {
	it("materializes assertion buffers and a null userHandle when absent", () => {
		const authData = u8(3, 3, 3);
		const sig = u8(8, 8, 8, 8);
		const json = authenticationResponseJSON({
			credentialIdStdB64: bytesToBase64(u8(1, 2)),
			authenticatorDataStdB64: bytesToBase64(authData),
			signatureStdB64: bytesToBase64(sig),
			clientDataB64Url: bytesToBase64Url(u8(123, 125)),
			// no userHandle
		});

		const cred = buildGetCredential(JSON.parse(json));
		const r = cred.response as AuthenticatorAssertionResponse;
		expect(bufBytes(r.authenticatorData)).toEqual([...authData]);
		expect(bufBytes(r.signature)).toEqual([...sig]);
		expect(r.userHandle).toBeNull();
	});

	it("materializes a userHandle when present", () => {
		const userHandle = u8(9, 9);
		const json = authenticationResponseJSON({
			credentialIdStdB64: bytesToBase64(u8(1, 2)),
			authenticatorDataStdB64: bytesToBase64(u8(3)),
			signatureStdB64: bytesToBase64(u8(4)),
			clientDataB64Url: bytesToBase64Url(u8(123, 125)),
			userHandleStdB64: bytesToBase64(userHandle),
		});

		const cred = buildGetCredential(JSON.parse(json));
		const r = cred.response as AuthenticatorAssertionResponse;
		expect(r.userHandle).not.toBeNull();
		expect(bufBytes(r.userHandle as ArrayBuffer)).toEqual([...userHandle]);
	});
});
