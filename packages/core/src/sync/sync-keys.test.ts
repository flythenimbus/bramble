import { describe, expect, it } from "vitest";
import { syncKeyFor } from "./sync-keys";

describe("syncKeyFor", () => {
	it("keeps the flat key for the legacy-slot vault (no migration, pairing survives)", () => {
		expect(syncKeyFor("sync.group", "a", "a")).toBe("sync.group");
		expect(syncKeyFor("sync.deviceKeypair", "a", "a")).toBe("sync.deviceKeypair");
	});

	it("namespaces every other vault by id", () => {
		expect(syncKeyFor("sync.group", "b", "a")).toBe("sync.group:b");
		expect(syncKeyFor("sync.deviceId", "b", "a")).toBe("sync.deviceId:b");
	});

	it("namespaces when there is no legacy vault", () => {
		expect(syncKeyFor("sync.group", "a", null)).toBe("sync.group:a");
	});
});
