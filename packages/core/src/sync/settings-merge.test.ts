import { describe, expect, it } from "vitest";
import type { EncryptedEntry } from "../vault-format";
import { payloadsEquivalent } from "./apply-remote";
import {
	type EntriesPayload,
	type SyncedSettings,
	sanitizeRemoteEntriesPayload,
} from "./entries-payload";
import type { Hlc } from "./hlc";
import { mergeEntriesPayload } from "./vault-merge";

// The synced settings map, and the properties that make it safe for clients that predate it.
// See docs/synced-settings.md; each case here is one of that note's confidence tests.

const hlc = (wall: number, node = "a", counter = 0): Hlc => ({ wall, counter, node });

const env = (id: string, ct: string, stamp: Hlc): EncryptedEntry => ({
	id,
	wrappedDek: `wd-${ct}`,
	dekIv: `di-${ct}`,
	ciphertext: ct,
	iv: `iv-${ct}`,
	hlc: stamp,
});

const payload = (over: Partial<EntriesPayload> = {}): EntriesPayload => ({
	entries: [],
	tombstones: [],
	...over,
});

const setting = (value: unknown | null, stamp: Hlc): SyncedSettings[string] => ({
	hlc: stamp,
	value,
});

describe("synced settings: the format cannot damage vault content", () => {
	// Confidence test 1. The claim the whole change rests on: adding the map leaves the merge of
	// entries and tombstones exactly as it was, so a client that predates it loses nothing but
	// the map itself.
	it("merges entries and tombstones identically whether or not a map is present", () => {
		const a = payload({
			entries: [env("1", "a1", hlc(10))],
			tombstones: [{ id: "2", hlc: hlc(5) }],
		});
		const b = payload({ entries: [env("1", "b1", hlc(20)), env("3", "b3", hlc(7))] });

		const withoutMap = mergeEntriesPayload(a, b);
		const withMap = mergeEntriesPayload(
			{ ...a, settings: { "pref.x": setting({ on: true }, hlc(1)) } },
			b,
		);

		expect(withMap.entries).toEqual(withoutMap.entries);
		expect(withMap.tombstones).toEqual(withoutMap.tombstones);
	});
});

describe("synced settings: merge rules", () => {
	// Confidence test 4. What makes an old client harmless: it strips the map, and its stripped
	// payload coming back must not read as "the user removed this".
	it("keeps a setting the other side has no opinion about", () => {
		const mine = payload({ settings: { "pref.x": setting("keep me", hlc(10)) } });
		const theirsStripped = payload();

		expect(mergeEntriesPayload(mine, theirsStripped).settings?.["pref.x"]?.value).toBe("keep me");
		// Both directions: gossip is symmetric, so an absent side must never win either way.
		expect(mergeEntriesPayload(theirsStripped, mine).settings?.["pref.x"]?.value).toBe("keep me");
	});

	it("takes the higher stamp when both sides have an opinion", () => {
		const older = payload({ settings: { "pref.x": setting("old", hlc(10)) } });
		const newer = payload({ settings: { "pref.x": setting("new", hlc(20)) } });

		expect(mergeEntriesPayload(older, newer).settings?.["pref.x"]?.value).toBe("new");
		expect(mergeEntriesPayload(newer, older).settings?.["pref.x"]?.value).toBe("new");
	});

	// Confidence test 5. Clearing has to be a value, because absence already means something else.
	it("lets an explicit null clear a value", () => {
		const set = payload({ settings: { "pref.x": setting("configured", hlc(10)) } });
		const cleared = payload({ settings: { "pref.x": setting(null, hlc(20)) } });

		expect(mergeEntriesPayload(set, cleared).settings?.["pref.x"]?.value).toBeNull();
		// And a stale clear does not win over a later reconfiguration.
		const reconfigured = payload({ settings: { "pref.x": setting("again", hlc(30)) } });
		expect(mergeEntriesPayload(cleared, reconfigured).settings?.["pref.x"]?.value).toBe("again");
	});

	// Confidence test 6. The one that catches a single stamp for the whole map: every other case
	// here passes with one, and only this fails.
	it("resolves each key independently, so two devices editing two settings both win", () => {
		const deviceA = payload({ settings: { "pref.x": setting("from A", hlc(10, "a")) } });
		const deviceB = payload({ settings: { "pref.y": setting("from B", hlc(11, "b")) } });

		const merged = mergeEntriesPayload(deviceA, deviceB).settings;
		expect(merged?.["pref.x"]?.value).toBe("from A");
		expect(merged?.["pref.y"]?.value).toBe("from B");
	});

	it("converges regardless of gossip order", () => {
		const a = payload({ settings: { "pref.x": setting("a", hlc(10, "a")) } });
		const b = payload({
			settings: { "pref.x": setting("b", hlc(20, "b")), "pref.y": setting(1, hlc(5)) },
		});
		const c = payload({ settings: { "pref.y": setting(2, hlc(30)) } });

		const left = mergeEntriesPayload(mergeEntriesPayload(a, b), c).settings;
		const right = mergeEntriesPayload(a, mergeEntriesPayload(b, c)).settings;
		expect(left).toEqual(right);
	});

	it("leaves the map absent when neither side has one", () => {
		expect(mergeEntriesPayload(payload(), payload()).settings).toBeUndefined();
	});
});

describe("synced settings: a change must be seen as a change", () => {
	// Confidence test 3. Without this the merge is judged redundant, nothing is written, nothing
	// re-broadcasts, and the setting appears to sync only when it rides along with an entry edit.
	it("payloadsEquivalent is false when only the map differs", () => {
		const before = payload({ entries: [env("1", "a", hlc(10))] });
		const after = { ...before, settings: { "pref.x": setting("new", hlc(20)) } };
		expect(payloadsEquivalent(before, after)).toBe(false);
	});

	it("payloadsEquivalent is false when a setting's stamp advances", () => {
		const before = payload({ settings: { "pref.x": setting("v", hlc(10)) } });
		const after = payload({ settings: { "pref.x": setting("v", hlc(20)) } });
		expect(payloadsEquivalent(before, after)).toBe(false);
	});

	it("payloadsEquivalent stays true for identical payloads", () => {
		const p = payload({
			entries: [env("1", "a", hlc(10))],
			settings: { "pref.x": setting("v", hlc(10)) },
		});
		expect(payloadsEquivalent(p, { ...p })).toBe(true);
	});
});

describe("synced settings: hostile input", () => {
	// Confidence test 7. Mirrors the entry guard: without it a clock-skewed or hostile peer pins
	// a setting at a stamp nobody can beat.
	it("drops a settings record stamped implausibly far in the future", () => {
		const now = 1_000_000;
		const remote = payload({
			settings: {
				"pref.ok": setting("fine", hlc(now - 1000)),
				"pref.pinned": setting("evil", hlc(now + 999_999_999)),
			},
		});
		const safe = sanitizeRemoteEntriesPayload(remote, now);
		expect(safe.settings?.["pref.ok"]).toBeDefined();
		expect(safe.settings?.["pref.pinned"]).toBeUndefined();
	});

	it("leaves a payload with no map alone", () => {
		expect(sanitizeRemoteEntriesPayload(payload(), 1_000_000).settings).toBeUndefined();
	});
});
