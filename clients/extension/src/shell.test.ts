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

describe("launchLogin", () => {
	async function shellWith(sendMessage: (msg: unknown) => Promise<unknown>) {
		const open = vi.fn();
		vi.stubGlobal("window", { open });
		vi.stubGlobal("chrome", {
			runtime: { getManifest: () => ({ name: "Bramble", version: "0.0.0" }), sendMessage },
		});
		return { shell: (await import("./shell")).extensionShell, open };
	}
	const URL_ = "https://example.com/login";

	it("asks the background to open and fill", async () => {
		const sendMessage = vi.fn(async () => ({ ok: true }));
		const { shell, open } = await shellWith(sendMessage);
		await shell.launchLogin?.("e1", URL_);
		expect(sendMessage).toHaveBeenCalledWith({
			type: "AUTOFILL_LAUNCH",
			payload: { entryId: "e1", url: URL_ },
		});
		expect(open).not.toHaveBeenCalled();
	});

	it("opens the page itself when the background can't be reached", async () => {
		const { shell, open } = await shellWith(async () => {
			throw new Error("no receiver");
		});
		await shell.launchLogin?.("e1", URL_);
		expect(open).toHaveBeenCalledWith(URL_, "_blank", "noopener,noreferrer");
	});

	it("opens the page itself when the background refuses", async () => {
		const { shell, open } = await shellWith(async () => ({ ok: false, error: "invalid_request" }));
		await shell.launchLogin?.("e1", URL_);
		expect(open).toHaveBeenCalledWith(URL_, "_blank", "noopener,noreferrer");
	});
});

// Issue #230.
describe("sync now and the sync log", () => {
	function stubRuntime(sendMessage: (msg: unknown) => Promise<unknown>) {
		const listeners: ((msg: unknown) => void)[] = [];
		vi.stubGlobal("chrome", {
			runtime: {
				getManifest: () => ({ name: "Bramble", version: "0.0.0" }),
				sendMessage,
				onMessage: {
					addListener: (cb: (msg: unknown) => void) => listeners.push(cb),
					removeListener: () => {},
				},
			},
		});
		return listeners;
	}

	it("asks the background to restart sync", async () => {
		const sendMessage = vi.fn(async () => ({ ok: true }));
		stubRuntime(sendMessage);
		const shell = (await import("./shell")).extensionShell;
		await shell.syncNow?.();
		expect(sendMessage).toHaveBeenCalledWith({ type: "SYNC_RESTART" });
	});

	it("says why when the background refuses", async () => {
		stubRuntime(async () => ({ ok: false, error: "the vault is locked" }));
		const shell = (await import("./shell")).extensionShell;
		await expect(shell.syncNow?.()).rejects.toThrow("the vault is locked");
	});

	it("passes each status line on with the time the host logged it", async () => {
		const listeners = stubRuntime(async () => ({ ok: true }));
		const shell = (await import("./shell")).extensionShell;
		const seen: [string, number][] = [];
		shell.onSyncStatus((status, at) => seen.push([status, at]));
		for (const cb of listeners)
			cb({ type: "SYNC_STATUS", payload: { status: "relay connected", at: 1_000 } });
		expect(seen).toEqual([["relay connected", 1_000]]);
	});
});
