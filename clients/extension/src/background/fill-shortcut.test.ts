import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type ChromeMockOptions,
	loadBackground,
	pageSender,
	setAutofillIndex,
	TEST_VEK_KEY,
} from "../test/test-harness";

// The fill shortcut (#215): Ctrl+Shift+L fills the page's login, also with "Autofill on web pages"
// off. Only the browser can deliver the command, so pressing it is what opens that tab to one fill.

const TAB = 11;
const LOGIN = {
	type: "login",
	id: "login1",
	hostnames: ["example.com"],
	name: "Example",
	username: "alice",
	password: "pw1",
};
const OFF = { localSeed: { "pref.autofillEnabled": false } };

async function unlocked(opts: ChromeMockOptions = {}) {
	const bg = await loadBackground({ sessionSeed: { [TEST_VEK_KEY]: "SEED" }, ...opts });
	await setAutofillIndex(bg, [LOGIN]);
	return bg;
}
type Bg = Awaited<ReturnType<typeof unlocked>>;

const press = async (bg: Bg, tabId = TAB) => {
	bg.fireCommand("fill-login", { id: tabId });
	await bg.flush();
};
const query = async (bg: Bg, tabId = TAB) =>
	(await bg.send({ type: "AUTOFILL_QUERY", hasLogin: true }, pageSender("example.com", tabId)))
		.resp;
const select = async (bg: Bg, tabId = TAB) =>
	(
		await bg.send(
			{ type: "AUTOFILL_SELECT", payload: { entryId: "login1" } },
			pageSender("example.com", tabId),
		)
	).resp;

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("the fill shortcut (#215)", () => {
	it("asks the tab it was pressed in to fill", async () => {
		const bg = await unlocked();
		await press(bg);
		expect(bg.state.tabMessages.map((m) => [m.tabId, m.message])).toContainEqual([
			TAB,
			{ type: "AUTOFILL_SHORTCUT" },
		]);
	});

	it("opens the unlock view when locked, and asks no tab", async () => {
		const bg = await loadBackground({ hasOpenPopup: true });
		await press(bg);
		expect(bg.chrome.action.openPopup).toHaveBeenCalled();
		expect(bg.state.tabMessages.filter((m) => m.message.type === "AUTOFILL_SHORTCUT")).toEqual([]);
	});

	it("lets that tab fill once while autofill on web pages is off", async () => {
		const bg = await unlocked(OFF);
		expect((await query(bg)).data.disabled).toBe(true);
		expect((await select(bg)).ok).toBe(false);

		await press(bg);
		expect((await query(bg)).data.logins.map((l: { id: string }) => l.id)).toEqual(["login1"]);
		const filled = await select(bg);
		expect(filled.ok).toBe(true);
		expect(filled.data.payload.password).toBe("pw1");

		expect((await select(bg)).ok).toBe(false);
		expect((await query(bg)).data.disabled).toBe(true);
	});

	it("opens no other tab", async () => {
		const bg = await unlocked(OFF);
		await press(bg);
		expect((await query(bg, 12)).data.disabled).toBe(true);
		expect((await select(bg, 12)).ok).toBe(false);
	});

	it("lapses after 30 seconds", async () => {
		const bg = await unlocked(OFF);
		vi.useFakeTimers({ toFake: ["Date"] });
		await press(bg);
		vi.setSystemTime(Date.now() + 30_001);
		expect((await select(bg)).ok).toBe(false);
	});

	it("ends when the vault locks", async () => {
		const bg = await unlocked(OFF);
		await press(bg);
		bg.fireCommand("lock-vault");
		await bg.flush();
		expect((await select(bg)).ok).toBe(false);
	});
});
