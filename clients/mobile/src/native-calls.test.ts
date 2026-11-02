import { describe, expect, it, vi } from "vitest";
import { pendingNativeCalls, trackNativeCalls } from "./native-calls";

function fakeBridge() {
	let next = 0;
	const sent: unknown[][] = [];
	const answered: unknown[] = [];
	const bridge = {
		toNative: vi.fn((...args: unknown[]) => {
			sent.push(args);
			return String(++next);
		}),
		fromNative: vi.fn((result: { callbackId?: unknown }) => {
			answered.push(result);
			return "delivered";
		}),
	};
	return { bridge, sent, answered };
}

describe("native call tracking", () => {
	it("lists unanswered calls by plugin and method, oldest first, and drops answered ones", () => {
		const { bridge, sent, answered } = fakeBridge();
		vi.useFakeTimers({ now: 1_000_000 });
		trackNativeCalls(bridge);

		expect(bridge.toNative("NativeWebRTC", "send", { data: "secret" }, undefined)).toBe("1");
		vi.advanceTimersByTime(30_000);
		bridge.toNative("NativeCrypto", "encryptWithVek", { plaintext: "secret" }, undefined);
		bridge.toNative("Filesystem", "writeFile", {}, undefined);
		expect(bridge.fromNative({ callbackId: "3" })).toBe("delivered");
		vi.advanceTimersByTime(12_000);

		expect(pendingNativeCalls()).toEqual([
			"NativeWebRTC.send 42s",
			"NativeCrypto.encryptWithVek 12s",
		]);
		// Every call still reaches the bridge as it was made, and every answer reaches the app.
		expect(sent[0]).toEqual(["NativeWebRTC", "send", { data: "secret" }, undefined]);
		expect(answered).toEqual([{ callbackId: "3" }]);
		vi.useRealTimers();
	});

	it("leaves out listener plumbing and console forwarding, which never answer once", () => {
		const { bridge } = fakeBridge();
		trackNativeCalls(bridge);
		bridge.toNative("App", "addListener", {}, undefined);
		bridge.toNative("App", "removeListener", {}, undefined);
		bridge.toNative("Console", "log", {}, undefined);
		expect(pendingNativeCalls().some((c) => /Listener|Console/.test(c))).toBe(false);
	});

	it("does nothing on a bridge without the native hooks", () => {
		const web = {};
		trackNativeCalls(web);
		expect(web).toEqual({});
	});
});
