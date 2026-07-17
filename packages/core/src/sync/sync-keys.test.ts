import { describe, expect, it } from "vitest";
import { syncKeyFor } from "./sync-keys";

describe("syncKeyFor", () => {
	it("namespaces every vault's sync key by id", () => {
		expect(syncKeyFor("sync.group", "a")).toBe("sync.group:a");
		expect(syncKeyFor("sync.deviceKeypair", "a")).toBe("sync.deviceKeypair:a");
		expect(syncKeyFor("sync.deviceId", "b")).toBe("sync.deviceId:b");
	});
});
