import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "./config.ts";

describe("parseConfig", () => {
	it("defaults to port 7401, ./data, 365 days, no token and no quota", () => {
		expect(parseConfig({})).toEqual({
			port: 7401,
			dataDir: "./data",
			token: null,
			retentionMaxDays: 365,
			quotaBytes: null,
		});
	});

	it("reads every variable", () => {
		expect(
			parseConfig({
				PORT: "9000",
				DATA_DIR: "/var/lib/mailbox",
				MAILBOX_TOKEN: "a-private-token-0123",
				RETENTION_MAX_DAYS: "30",
				QUOTA_BYTES: "1073741824",
			}),
		).toEqual({
			port: 9000,
			dataDir: "/var/lib/mailbox",
			token: "a-private-token-0123",
			retentionMaxDays: 30,
			quotaBytes: 1073741824,
		});
	});

	it("treats an empty variable as unset", () => {
		expect(parseConfig({ QUOTA_BYTES: "", MAILBOX_TOKEN: "" }).quotaBytes).toBeNull();
	});

	it("refuses a short token without echoing it", () => {
		expect(() => parseConfig({ MAILBOX_TOKEN: "short-secret" })).toThrow(ConfigError);
		try {
			parseConfig({ MAILBOX_TOKEN: "short-secret" });
		} catch (e) {
			expect(String(e)).toContain("MAILBOX_TOKEN");
			expect(String(e)).not.toContain("short-secret");
		}
	});

	it("refuses a retention outside 1 to 3650 days and a non-numeric quota", () => {
		expect(() => parseConfig({ RETENTION_MAX_DAYS: "0" })).toThrow(ConfigError);
		expect(() => parseConfig({ RETENTION_MAX_DAYS: "3651" })).toThrow(ConfigError);
		expect(() => parseConfig({ QUOTA_BYTES: "lots" })).toThrow(/QUOTA_BYTES/);
	});
});
