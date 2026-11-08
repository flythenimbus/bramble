import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { relayInfoResponse, wantsRelayInfo } from "./relay-info.ts";

const LIMITS = { maxMessageLength: 1000, maxSubscriptions: 3 };
const request = (headers: Record<string, string>, method = "GET") =>
	new Request("https://relay.example/", { method, headers });

describe("wantsRelayInfo", () => {
	it("is true for a GET that accepts application/nostr+json", () => {
		assert.equal(wantsRelayInfo(request({ Accept: "application/nostr+json" })), true);
	});

	it("is false for a plain GET, which is the health probe", () => {
		assert.equal(wantsRelayInfo(request({})), false);
	});

	it("is false for a WebSocket upgrade", () => {
		const upgrade = request({ Accept: "application/nostr+json", Upgrade: "websocket" });
		assert.equal(wantsRelayInfo(upgrade), false);
	});

	it("is false for a POST", () => {
		assert.equal(wantsRelayInfo(request({ Accept: "application/nostr+json" }, "POST")), false);
	});
});

describe("relayInfoResponse", () => {
	it("is readable cross-origin, as NIP-11 requires", () => {
		const res = relayInfoResponse(LIMITS);
		assert.equal(res.headers.get("Content-Type"), "application/nostr+json");
		assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
	});

	it("reports the limits it is given", async () => {
		const info = (await relayInfoResponse(LIMITS).json()) as {
			supported_nips: number[];
			description: string;
			limitation: Record<string, unknown>;
		};
		assert.deepEqual(info.supported_nips, [1, 11]);
		assert.match(info.description, /does not verify signatures/);
		assert.equal(info.limitation.max_message_length, 1000);
		assert.equal(info.limitation.max_subscriptions, 3);
		assert.equal(info.limitation.max_subid_length, 64);
	});
});
