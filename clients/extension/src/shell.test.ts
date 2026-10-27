import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.resetModules();
});

/** The popup's shell with the active tab on `url`. */
async function shellOnTab(url: string) {
	vi.stubGlobal("chrome", {
		runtime: { getManifest: () => ({ name: "Bramble", version: "0.0.0" }) },
		tabs: { query: vi.fn(async () => [{ url }]) },
	});
	return (await import("./shell")).extensionShell;
}

describe("matchCurrentTab (the vault list's matches for this site)", () => {
	const LOGINS = [
		{ id: "dsm", urls: ["http://nas.local:5000"], subdomainMatch: "exact" as const },
		{ id: "portainer", urls: ["http://nas.local:9000"], subdomainMatch: "exact" as const },
		{ id: "any-port", urls: ["https://nas.local"], subdomainMatch: "exact" as const },
		{ id: "default", urls: ["http://nas.local:9000"] },
	];

	it("floats only the exact logins saved for the tab's port", async () => {
		const shell = await shellOnTab("http://nas.local:5000/webman/index.cgi");
		expect(await shell.matchCurrentTab(LOGINS)).toEqual(["dsm", "any-port", "default"]);
	});

	it("reads a tab with no port as its scheme's default", async () => {
		const shell = await shellOnTab("http://nas.local/");
		expect(await shell.matchCurrentTab(LOGINS)).toEqual(["any-port", "default"]);
	});
});
