import { beforeEach, describe, expect, it, vi } from "vitest";

// Drive the two delivery paths by hand: the cold-launch URL pull and the appUrlOpen event.
const { handlers, getLaunchUrl } = vi.hoisted(() => ({
	handlers: {} as Record<string, (arg: { url: string }) => void>,
	getLaunchUrl: vi.fn(),
}));

vi.mock("@capacitor/app", () => ({
	App: {
		getLaunchUrl,
		addListener: (event: string, cb: (arg: { url: string }) => void) => {
			handlers[event] = cb;
			return Promise.resolve({
				remove: () => {
					delete handlers[event];
				},
			});
		},
	},
}));

const { onTotpHandoff, resetLaunchUrlForTest } = await import("./totp-handoff");

const OTPAUTH = "otpauth://totp/GitHub:octocat?secret=JBSWY3DPEHPK3PXP&issuer=GitHub";

beforeEach(() => {
	vi.clearAllMocks();
	for (const k of Object.keys(handlers)) delete handlers[k];
	resetLaunchUrlForTest();
	getLaunchUrl.mockResolvedValue(undefined);
});

describe("onTotpHandoff", () => {
	it("delivers the cold-launch URL", async () => {
		getLaunchUrl.mockResolvedValue({ url: OTPAUTH });
		const cb = vi.fn();
		onTotpHandoff(cb);
		await vi.waitFor(() => expect(cb).toHaveBeenCalledWith(OTPAUTH));
	});

	it("delivers a URL opened while running", async () => {
		const cb = vi.fn();
		onTotpHandoff(cb);
		await vi.waitFor(() => expect(handlers.appUrlOpen).toBeDefined());
		handlers.appUrlOpen?.({ url: OTPAUTH });
		expect(cb).toHaveBeenCalledWith(OTPAUTH);
	});

	// getLaunchUrl reports the launching URL for the whole process lifetime, and Android
	// re-delivers the original intent to a recreated activity. Re-reading it would replay a
	// key the user already placed or declined.
	it("reads the launch URL once per process, not once per subscriber", async () => {
		getLaunchUrl.mockResolvedValue({ url: OTPAUTH });
		const first = vi.fn();
		const off = onTotpHandoff(first);
		await vi.waitFor(() => expect(first).toHaveBeenCalledWith(OTPAUTH));
		off();

		const second = vi.fn();
		onTotpHandoff(second);
		await vi.waitFor(() => expect(handlers.appUrlOpen).toBeDefined());
		expect(second).not.toHaveBeenCalled();
		expect(getLaunchUrl).toHaveBeenCalledTimes(1);
	});

	// A subscriber torn down before the read resolves (a remount) must leave the key for the
	// next one; marking it delivered on read would lose the whole cold-launch path.
	it("leaves the launch URL for the next subscriber when the first one is gone", async () => {
		getLaunchUrl.mockResolvedValue({ url: OTPAUTH });
		const first = vi.fn();
		onTotpHandoff(first)();

		const second = vi.fn();
		onTotpHandoff(second);
		await vi.waitFor(() => expect(second).toHaveBeenCalledWith(OTPAUTH));
		expect(first).not.toHaveBeenCalled();
		expect(getLaunchUrl).toHaveBeenCalledTimes(1);
	});

	it("ignores a URL that isn't an otpauth key", async () => {
		const cb = vi.fn();
		onTotpHandoff(cb);
		await vi.waitFor(() => expect(handlers.appUrlOpen).toBeDefined());
		handlers.appUrlOpen?.({ url: "https://bramble.app/" });
		expect(cb).not.toHaveBeenCalled();
	});

	it("stops delivering after unsubscribe", async () => {
		const cb = vi.fn();
		const off = onTotpHandoff(cb);
		await vi.waitFor(() => expect(handlers.appUrlOpen).toBeDefined());
		const fire = handlers.appUrlOpen;
		off();
		fire?.({ url: OTPAUTH });
		expect(cb).not.toHaveBeenCalled();
	});

	// A cold launch with no URL is the ordinary case (tapping the app icon); it must not
	// reject into the boot path.
	it("survives getLaunchUrl rejecting", async () => {
		getLaunchUrl.mockRejectedValue(new Error("no launch url"));
		const cb = vi.fn();
		expect(() => onTotpHandoff(cb)).not.toThrow();
		await vi.waitFor(() => expect(handlers.appUrlOpen).toBeDefined());
		expect(cb).not.toHaveBeenCalled();
	});
});
