import { beforeEach, describe, expect, it, vi } from "vitest";

// Control the native CredentialExchange plugin that registerPlugin() returns at import time.
const native = vi.hoisted(() => ({
	isAvailable: vi.fn(),
	requestExport: vi.fn(),
	exportCredentials: vi.fn(),
	consumeImportToken: vi.fn(),
	importCredentials: vi.fn(),
}));

const autoLock = vi.hoisted(() => ({ armFilePickGrace: vi.fn() }));

vi.mock("@capacitor/core", () => ({ registerPlugin: () => native }));
vi.mock("./auto-lock", () => autoLock);

const { claimImportToken, exchangeAvailability, exportToApp, redeemImportToken } = await import(
	"./credential-exchange"
);

beforeEach(() => {
	vi.clearAllMocks();
});

describe("exchangeAvailability", () => {
	it("reports what the plugin says", async () => {
		native.isAvailable.mockResolvedValue({ available: true, providerEnabled: false });
		expect(await exchangeAvailability()).toEqual({ available: true, providerEnabled: false });
	});

	// Keeping the reason is the difference between "this OS can't" and "the plugin didn't load",
	// which the UI shows the user instead of silently hiding the feature.
	it("reports unavailable WITH the reason when the native call fails, rather than throwing", async () => {
		native.isAvailable.mockRejectedValue(new Error("not implemented"));
		expect(await exchangeAvailability()).toEqual({
			available: false,
			providerEnabled: false,
			error: "not implemented",
		});
	});
});

describe("exportToApp", () => {
	beforeEach(() => {
		native.requestExport.mockResolvedValue({ formatVersion: "1.0" });
		native.exportCredentials.mockResolvedValue(undefined);
	});

	it("picks the destination BEFORE reading the vault, and passes the negotiated version", async () => {
		const order: string[] = [];
		native.requestExport.mockImplementation(async () => {
			order.push("requestExport");
			return { formatVersion: "1.0" };
		});
		await exportToApp((version) => {
			order.push(`build:${version}`);
			return "{}";
		});
		expect(order).toEqual(["requestExport", "build:1.0"]);
		expect(native.exportCredentials).toHaveBeenCalledWith({ cxfJson: "{}" });
	});

	it("arms the auto-lock grace before each system sheet, or the transfer dies on backgrounding", async () => {
		await exportToApp(() => "{}");
		expect(autoLock.armFilePickGrace).toHaveBeenCalledTimes(2);
	});

	it("does not export when the user cancels the destination picker", async () => {
		native.requestExport.mockRejectedValue(new Error("cancelled"));
		await expect(exportToApp(() => "{}")).rejects.toThrow("cancelled");
		expect(native.exportCredentials).not.toHaveBeenCalled();
	});

	it("awaits an async payload builder", async () => {
		await exportToApp(async () => '{"a":1}');
		expect(native.exportCredentials).toHaveBeenCalledWith({ cxfJson: '{"a":1}' });
	});
});

describe("import token", () => {
	it("returns null when nothing is waiting", async () => {
		native.consumeImportToken.mockResolvedValue({});
		expect(await claimImportToken()).toBeNull();
	});

	it("returns null instead of throwing on a platform without the plugin", async () => {
		native.consumeImportToken.mockRejectedValue(new Error("not implemented"));
		expect(await claimImportToken()).toBeNull();
	});

	it("claiming does not fetch the payload, so nothing is decrypted while still locked", async () => {
		native.consumeImportToken.mockResolvedValue({ token: "T" });
		expect(await claimImportToken()).toBe("T");
		expect(native.importCredentials).not.toHaveBeenCalled();
	});

	it("redeeming fetches the payload and arms the grace", async () => {
		native.importCredentials.mockResolvedValue({ cxfJson: '{"accounts":[]}' });
		expect(await redeemImportToken("T")).toBe('{"accounts":[]}');
		expect(native.importCredentials).toHaveBeenCalledWith({ token: "T" });
		expect(autoLock.armFilePickGrace).toHaveBeenCalledTimes(1);
	});
});
