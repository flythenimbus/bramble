import { describe, expect, it } from "vitest";
import { normalizeS3 } from "./config";

describe("normalizeS3", () => {
	it("passes a plain bucket + endpoint through", () => {
		expect(normalizeS3({ endpoint: "https://s3.example.com", bucket: "mybucket" })).toEqual({
			endpoint: "https://s3.example.com",
			bucket: "mybucket",
			prefix: undefined,
		});
	});

	it("splits a full URL pasted in the bucket field (R2 style)", () => {
		expect(
			normalizeS3({
				endpoint: "https://<account-id>.r2.cloudflarestorage.com",
				bucket: "https://abc123.r2.cloudflarestorage.com/bramble-backup-tests",
			}),
		).toEqual({
			endpoint: "https://abc123.r2.cloudflarestorage.com",
			bucket: "bramble-backup-tests",
			prefix: undefined,
		});
	});

	it("splits a full URL in the endpoint field, keeping extra path as prefix", () => {
		expect(
			normalizeS3({ endpoint: "https://host.example.com/mybucket/nested/dir", bucket: "" }),
		).toEqual({
			endpoint: "https://host.example.com",
			bucket: "mybucket",
			prefix: "nested/dir",
		});
	});

	it("strips a trailing slash from a bare endpoint", () => {
		expect(normalizeS3({ endpoint: "https://s3.example.com/", bucket: "b" })).toEqual({
			endpoint: "https://s3.example.com",
			bucket: "b",
			prefix: undefined,
		});
	});
});
