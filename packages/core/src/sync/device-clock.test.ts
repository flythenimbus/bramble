import { describe, expect, it } from "vitest";
import { DEVICE_ID_KEY, ensureDeviceId } from "./device-clock";

function memoryMeta() {
	const store = new Map<string, string>();
	return {
		get: (k: string) => Promise.resolve(store.get(k)),
		set: (k: string, v: string) => {
			store.set(k, v);
			return Promise.resolve();
		},
		store,
	};
}

describe("ensureDeviceId", () => {
	it("generates and persists an id on first use", async () => {
		const m = memoryMeta();
		const id = await ensureDeviceId(m.get, m.set);
		expect(id).toMatch(/[0-9a-f-]{36}/);
		expect(m.store.get(DEVICE_ID_KEY)).toBe(id);
	});

	it("returns the same id on subsequent calls", async () => {
		const m = memoryMeta();
		const first = await ensureDeviceId(m.get, m.set);
		const second = await ensureDeviceId(m.get, m.set);
		expect(second).toBe(first);
	});
});
