import { describe, expect, it } from "vitest";
import { signS3Request, uriEncode } from "./sigv4";

describe("SigV4 signing", () => {
	// Reference vector from AWS's "Signature Calculations ... GET Object" example.
	// https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
	it("matches the AWS GET Object reference signature", async () => {
		const { headers } = await signS3Request({
			method: "GET",
			url: "https://examplebucket.s3.amazonaws.com/test.txt",
			headers: { range: "bytes=0-9" },
			credentials: {
				accessKeyId: "AKIAIOSFODNN7EXAMPLE",
				secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
				region: "us-east-1",
			},
			amzDate: "20130524T000000Z",
		});
		const signature = /Signature=([0-9a-f]+)/.exec(headers.Authorization ?? "")?.[1];
		expect(signature).toBe("f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
		expect(headers.Authorization).toContain(
			"Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request",
		);
		expect(headers.Authorization).toContain(
			"SignedHeaders=host;range;x-amz-content-sha256;x-amz-date",
		);
		expect(headers["x-amz-content-sha256"]).toBe(
			"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		);
	});

	// A backup folder with a space signed as `/my%2520folder` while fetch sent `/my%20folder`, so
	// the server computed a different signature and every upload failed with SignatureDoesNotMatch
	// for any prefix outside [A-Za-z0-9-._~]. `URL.pathname` is already encoded; encoding it again
	// was the bug. The expected value here comes from the Rust signer, which signs the wire form.
	it("encodes the path exactly once, whatever the folder is called", async () => {
		const credentials = {
			accessKeyId: "AKIAIOSFODNN7EXAMPLE",
			secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
			region: "us-east-1",
		};
		const signed = async (url: string) =>
			(await signS3Request({ method: "GET", url, credentials, amzDate: "20260814T101112Z" }))
				.headers.Authorization;

		// The literal space and its encoded form are the same request, so they sign identically.
		expect(await signed("https://h.example.com/b/my folder/x")).toBe(
			await signed("https://h.example.com/b/my%20folder/x"),
		);
		// And a path needing no encoding is unaffected by the change.
		expect(await signed("https://h.example.com/b/plain/x")).toContain("Signature=");
	});

	it("uri-encodes per AWS rules", () => {
		expect(uriEncode("test$file.text")).toBe("test%24file.text");
		expect(uriEncode("/a b/c", false)).toBe("/a%20b/c");
		expect(uriEncode("/a b/c", true)).toBe("%2Fa%20b%2Fc");
		expect(uriEncode("aA0-._~")).toBe("aA0-._~");
	});
});
