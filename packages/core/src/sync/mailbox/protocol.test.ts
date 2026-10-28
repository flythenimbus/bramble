import { describe, expect, it } from "vitest";
import {
	AckBodySchema,
	BLOB_HASH_RE,
	canonicalRequest,
	EMPTY_SHA256,
	MAILBOX_ID_RE,
	MAX_LIST,
	MESSAGE_ID_RE,
	PostMessageBodySchema,
	SIG_KEY_RE,
	sha256Hex,
} from "./protocol";

describe("canonicalRequest", () => {
	it("joins domain, upper-cased method, path with query, time and body hash with newlines", () => {
		expect(
			canonicalRequest({
				method: "post",
				pathAndQuery: "/v1/mailboxes/abc/acks?x=1",
				time: 1730000000000,
				contentSha256: EMPTY_SHA256,
			}),
		).toBe(`bramble-mailbox/v1\nPOST\n/v1/mailboxes/abc/acks?x=1\n1730000000000\n${EMPTY_SHA256}`);
	});
});

describe("sha256Hex", () => {
	it("hashes the empty input to EMPTY_SHA256 and 'abc' to the known digest", async () => {
		expect(await sha256Hex(new Uint8Array())).toBe(EMPTY_SHA256);
		expect(await sha256Hex("abc")).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
	});
});

describe("id patterns", () => {
	it("accept well-formed ids and refuse path-shaped ones", () => {
		expect(MAILBOX_ID_RE.test("A".repeat(43))).toBe(true);
		expect(MAILBOX_ID_RE.test(`${"A".repeat(41)}/.`)).toBe(false);
		expect(MESSAGE_ID_RE.test("../../../../etc/passwd")).toBe(false);
		expect(BLOB_HASH_RE.test("A".repeat(64))).toBe(false);
		expect(SIG_KEY_RE.test(`${"A".repeat(43)}=`)).toBe(true);
	});
});

describe("schemas", () => {
	it("default AckBody lists to empty and cap them at MAX_LIST", () => {
		expect(AckBodySchema.parse({})).toEqual({ messages: [], blobs: [], markers: [] });
		expect(
			AckBodySchema.safeParse({ messages: Array(MAX_LIST + 1).fill("A".repeat(22)) }).success,
		).toBe(false);
	});

	it("refuse a PostMessageBody whose `to` is empty", () => {
		expect(PostMessageBodySchema.safeParse({ id: "A".repeat(22), body: "", to: [] }).success).toBe(
			false,
		);
	});
});
