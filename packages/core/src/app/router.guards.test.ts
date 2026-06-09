import { describe, expect, it } from "vitest";
import type { Entry } from "../hooks/useVault";
import { createAppRouter } from "./router";

// Guards are pure functions of injected vault context; headless load() records
// redirect() on router.state.redirect rather than following it.
type VaultSlice = { isLocked: boolean; ready: boolean; entries: Entry[] };

const login = (id: string): Entry => ({
	id,
	type: "login",
	name: id,
	urls: [],
	username: "",
	password: "",
});

async function destination(initialPath: string, vault?: VaultSlice): Promise<string> {
	const router = createAppRouter(initialPath);
	if (vault) router.update({ context: { vault } });
	await router.load();
	const redirect = (router.state as { redirect?: { options: { to: string } } }).redirect;
	return redirect?.options.to ?? router.state.location.pathname;
}

describe("route guards", () => {
	it("redirects an unlocked vault off the auth screen (the unlock transition)", async () => {
		expect(await destination("/", { isLocked: false, ready: true, entries: [] })).toBe("/vault");
	});

	it("keeps a locked vault on the auth screen", async () => {
		expect(await destination("/", { isLocked: true, ready: true, entries: [] })).toBe("/");
	});

	it("bounces a deep route to auth on a lock-while-mounted (parent _app guard wins, not /vault)", async () => {
		expect(await destination("/vault/abc", { isLocked: true, ready: true, entries: [] })).toBe("/");
	});

	it("does NOT bounce a detached deep-link during hydration (ready=false)", async () => {
		expect(await destination("/vault/abc", { isLocked: true, ready: false, entries: [] })).toBe(
			"/vault/abc",
		);
	});

	it("restores a detached deep-link once hydrated with the entry present", async () => {
		expect(
			await destination("/vault/abc", { isLocked: false, ready: true, entries: [login("abc")] }),
		).toBe("/vault/abc");
	});

	it("redirects a stale/deleted entry id to the vault list", async () => {
		expect(await destination("/vault/abc", { isLocked: false, ready: true, entries: [] })).toBe(
			"/vault",
		);
	});

	it("makes no guard decision before context is injected (first-paint placeholder)", async () => {
		// undefined-vault placeholder: guards must skip, not crash or redirect.
		expect(await destination("/")).toBe("/");
	});
});

// Back button prefers history.back(), falling back to staticData.back when canGoBack() is false.
describe("back-button history premise", () => {
	it("a window booted straight onto a deep route has no history (→ uses the fallback target)", async () => {
		const router = createAppRouter("/vault/abc/edit");
		router.update({
			context: { vault: { isLocked: false, ready: true, entries: [login("abc")] } },
		});
		await router.load();
		expect(router.history.canGoBack()).toBe(false);
	});

	it("opening a deep route in-app builds history (→ goes back where it came from)", async () => {
		const router = createAppRouter("/vault");
		router.update({
			context: { vault: { isLocked: false, ready: true, entries: [login("abc")] } },
		});
		await router.load();
		expect(router.history.canGoBack()).toBe(false);
		await router.navigate({ to: "/vault/$entryId/edit", params: { entryId: "abc" } });
		expect(router.history.canGoBack()).toBe(true);
	});
});
