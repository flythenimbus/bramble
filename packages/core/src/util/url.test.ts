import { describe, expect, it } from "vitest";
import { launchableUrl } from "./url";

describe("launchableUrl", () => {
	it("opens a bare host over https", () => {
		expect(launchableUrl("example.com")).toBe("https://example.com/");
		expect(launchableUrl(" nas.local:5000/login ")).toBe("https://nas.local:5000/login");
	});

	it("keeps an explicit http(s) URL as stored", () => {
		expect(launchableUrl("http://192.168.1.1")).toBe("http://192.168.1.1/");
		expect(launchableUrl("https://example.com/a?b=c")).toBe("https://example.com/a?b=c");
	});

	it("never links an app URI or another scheme", () => {
		expect(launchableUrl("androidapp://com.example.app")).toBeNull();
		expect(launchableUrl("javascript://example.com/%0aalert(1)")).toBeNull();
		expect(launchableUrl("javascript:alert(1)")).toBeNull();
		expect(launchableUrl("file:///etc/passwd")).toBeNull();
		expect(launchableUrl("data:text/html,<b>x</b>")).toBeNull();
	});

	it("gives up on what doesn't parse", () => {
		expect(launchableUrl("")).toBeNull();
		expect(launchableUrl("not a url")).toBeNull();
	});
});
