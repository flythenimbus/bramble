import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	ephemeralEvent,
	matches,
	type NostrEvent,
	type NostrFilter,
	validEventFields,
	validFilter,
	validReq,
} from "./nostr-filter.ts";

const ROOM_FILTER = { kinds: [20000], "#d": ["room"] };

describe("validReq", () => {
	it("accepts the filter every client sends", () => {
		assert.equal(validReq("s0", [ROOM_FILTER]), true);
	});

	it("rejects filters the fan-out would throw on", () => {
		for (const bad of [
			null,
			5,
			"x",
			[],
			{ kinds: 5 },
			{ kinds: ["1"] },
			{ authors: [1] },
			{ "#d": "room" },
		]) {
			assert.equal(validFilter(bad), false, JSON.stringify(bad));
			assert.equal(validReq("s0", [ROOM_FILTER, bad]), false, JSON.stringify(bad));
		}
	});

	it("rejects a missing, empty or oversized subscription id, and no filters", () => {
		assert.equal(validReq(undefined, [ROOM_FILTER]), false);
		assert.equal(validReq("", [ROOM_FILTER]), false);
		assert.equal(validReq("s".repeat(65), [ROOM_FILTER]), false);
		assert.equal(validReq(7, [ROOM_FILTER]), false);
		assert.equal(validReq("s0", []), false);
	});
});

describe("events", () => {
	it("takes only integer ephemeral kinds", () => {
		assert.equal(ephemeralEvent({ kind: 20000 }), true);
		for (const bad of [
			null,
			"x",
			{ kind: 1 },
			{ kind: 30000 },
			{ kind: "20000" },
			{ kind: 20000.5 },
		]) {
			assert.equal(ephemeralEvent(bad), false, JSON.stringify(bad));
		}
	});

	it("rejects fields the fan-out reads as strings or arrays", () => {
		const ok: NostrEvent = {
			kind: 20000,
			id: "i",
			pubkey: "p",
			content: "c",
			tags: [["d", "room"]],
		};
		assert.equal(validEventFields(ok), true);
		for (const patch of [
			{ tags: "x" },
			{ tags: [null] },
			{ tags: [[1]] },
			{ pubkey: 1 },
			{ id: {} },
		]) {
			assert.equal(validEventFields({ ...ok, ...patch } as unknown as NostrEvent), false);
		}
	});

	it("matches a validated event against a validated filter without throwing", () => {
		const event: NostrEvent = { kind: 20000, tags: [["d", "room"]] };
		assert.equal(matches(ROOM_FILTER as NostrFilter, event), true);
		assert.equal(matches(ROOM_FILTER as NostrFilter, { kind: 20000 }), false);
		assert.equal(matches({ kinds: [20001] }, event), false);
	});
});
