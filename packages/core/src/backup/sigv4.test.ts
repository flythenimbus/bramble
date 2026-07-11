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

	it("uri-encodes per AWS rules", () => {
		expect(uriEncode("test$file.text")).toBe("test%24file.text");
		expect(uriEncode("/a b/c", false)).toBe("/a%20b/c");
		expect(uriEncode("/a b/c", true)).toBe("%2Fa%20b%2Fc");
		expect(uriEncode("aA0-._~")).toBe("aA0-._~");
	});
});
