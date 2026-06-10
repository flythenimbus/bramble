import { afterEach, describe, expect, it, vi } from "vitest";
import { extensionSender, loadBackground, pageSender } from "./test-harness";

afterEach(() => {
	vi.unstubAllGlobals();
});

const VEK_KEY = "vault.vek";
const AUTOLOCK = "vault:autolock";

describe("CRYPTO_ session state sync", () => {
	it("CRYPTO_GENERATE_VEK caches and persists the VEK and arms auto-lock", async () => {
		const bg = await loadBackground();
		const { resp } = await bg.send({ type: "CRYPTO_GENERATE_VEK" });
		expect(resp).toEqual({ ok: true, data: "VEK_GENERATED" });
		expect(bg.state.session[VEK_KEY]).toBe("VEK_GENERATED");
		expect(bg.state.alarms[AUTOLOCK]).toBeDefined();
	});

	it("CRYPTO_UNWRAP_PASSWORD_SLOT (verifier match) unlocks by exporting the VEK", async () => {
		const bg = await loadBackground();
		const { resp } = await bg.send({ type: "CRYPTO_UNWRAP_PASSWORD_SLOT" });
		expect(resp).toEqual({ ok: true, data: true });
		// Exported VEK is cached, not the unwrap result.
		expect(bg.state.session[VEK_KEY]).toBe("VEK_EXPORTED");
		expect(bg.state.alarms[AUTOLOCK]).toBeDefined();
		expect(bg.state.offscreenCalls.map((m) => m.type)).toContain("CRYPTO_EXPORT_VEK");
	});

	it("CRYPTO_UNWRAP_PASSWORD_SLOT (verifier miss) does not unlock", async () => {
		const bg = await loadBackground({
			offscreen: (msg) =>
				msg.type === "CRYPTO_UNWRAP_PASSWORD_SLOT"
					? { ok: true, data: false }
					: { ok: true, data: null },
		});
		const { resp } = await bg.send({ type: "CRYPTO_UNWRAP_PASSWORD_SLOT" });
		expect(resp).toEqual({ ok: true, data: false });
		expect(bg.state.session[VEK_KEY]).toBeUndefined();
		expect(bg.state.alarms[AUTOLOCK]).toBeUndefined();
		expect(bg.state.offscreenCalls.map((m) => m.type)).not.toContain("CRYPTO_EXPORT_VEK");
	});

	it("CRYPTO_UNLOCK_WITH_VEK caches the supplied VEK (rotation rollback)", async () => {
		const bg = await loadBackground();
		await bg.send({ type: "CRYPTO_UNLOCK_WITH_VEK", payload: { vekB64: "ROLLED_BACK" } });
		expect(bg.state.session[VEK_KEY]).toBe("ROLLED_BACK");
	});

	it("CRYPTO_ROTATE_VEK caches the rotated VEK", async () => {
		const bg = await loadBackground();
		await bg.send({ type: "CRYPTO_ROTATE_VEK" });
		expect(bg.state.session[VEK_KEY]).toBe("VEK_ROTATED");
	});

	it("CRYPTO_LOCK clears the session VEK, capture stashes, and the auto-lock alarm", async () => {
		const bg = await loadBackground({
			sessionSeed: {
				[VEK_KEY]: "SEED",
				"capture.pending.example.com": { hostname: "example.com" },
				"cornerPrompt.handoff": { intent: "save" },
				"popout.handoff": { draft: 1 },
				// Ciphertext: intentionally preserved across lock.
				"vault.pendingFlush": { blobB64: "x" },
			},
		});
		await bg.send({ type: "CRYPTO_GENERATE_VEK" }); // ensure alarm exists
		expect(bg.state.alarms[AUTOLOCK]).toBeDefined();

		await bg.send({ type: "CRYPTO_LOCK" });
		expect(bg.state.session[VEK_KEY]).toBeUndefined();
		expect(bg.state.session["capture.pending.example.com"]).toBeUndefined();
		expect(bg.state.session["cornerPrompt.handoff"]).toBeUndefined();
		expect(bg.state.session["popout.handoff"]).toBeUndefined();
		expect(bg.state.alarms[AUTOLOCK]).toBeUndefined();
		// PENDING_BLOB_KEY is ciphertext and must survive a lock.
		expect(bg.state.session["vault.pendingFlush"]).toBeDefined();
	});
});

describe("lock triggers (alarm / command / idle)", () => {
	it("the auto-lock alarm clears the session and locks offscreen", async () => {
		const bg = await loadBackground();
		await bg.send({ type: "CRYPTO_GENERATE_VEK" });
		bg.fireAlarm(AUTOLOCK);
		await bg.flush();
		expect(bg.state.session[VEK_KEY]).toBeUndefined();
		expect(bg.state.offscreenCalls.map((m) => m.type)).toContain("CRYPTO_LOCK");
	});

	it("the lock-vault command locks; other commands are ignored", async () => {
		const bg = await loadBackground();
		await bg.send({ type: "CRYPTO_GENERATE_VEK" });
		bg.fireCommand("not-our-command");
		await bg.flush();
		expect(bg.state.session[VEK_KEY]).toBe("VEK_GENERATED");
		bg.fireCommand("lock-vault");
		await bg.flush();
		expect(bg.state.session[VEK_KEY]).toBeUndefined();
	});

	it("OS screen-lock locks when unlocked, and is a no-op when already locked", async () => {
		const bg = await loadBackground();
		await bg.send({ type: "CRYPTO_GENERATE_VEK" });
		bg.fireIdle("locked");
		await bg.flush();
		expect(bg.state.session[VEK_KEY]).toBeUndefined();
		const lockCalls = () => bg.state.offscreenCalls.filter((m) => m.type === "CRYPTO_LOCK").length;
		const after = lockCalls();
		// Already locked: a second screen-lock must not spin offscreen back up.
		bg.fireIdle("locked");
		await bg.flush();
		expect(lockCalls()).toBe(after);
		// Non-locked idle states are ignored.
		bg.fireIdle("idle");
		await bg.flush();
		expect(lockCalls()).toBe(after);
	});
});

describe("vault lock state drives query results", () => {
	it("an unlocked index serves matches; a lock makes the same query report locked", async () => {
		const bg = await loadBackground({ sessionSeed: { [VEK_KEY]: "SEED" } });
		await bg.send(
			{
				type: "AUTOFILL_SET_INDEX",
				payload: [
					{ type: "login", id: "a", hostnames: ["example.com"], name: "Example", username: "u" },
				],
			},
			extensionSender,
		);
		const unlocked = await bg.send(
			{ type: "AUTOFILL_FIND", payload: { hostname: "example.com", hasLogin: true } },
			extensionSender,
		);
		expect(unlocked.resp.data.locked).toBe(false);
		expect(unlocked.resp.data.logins).toHaveLength(1);

		await bg.send({ type: "CRYPTO_LOCK" });
		const locked = await bg.send(
			{ type: "AUTOFILL_FIND", payload: { hostname: "example.com", hasLogin: true } },
			extensionSender,
		);
		expect(locked.resp.data.locked).toBe(true);
		expect(locked.resp.data.logins).toHaveLength(0);
		// Hostname stays registered, so the locked hint still fires for this domain.
		expect(locked.resp.data.hasPotentialMatch).toBe(true);
	});

	it("reschedules auto-lock when the timeout pref changes while unlocked", async () => {
		const bg = await loadBackground();
		await bg.send({ type: "CRYPTO_GENERATE_VEK" });
		bg.chrome.alarms.create.mockClear();
		bg.fireStorageChanged({ "pref.autoLockMinutes": { newValue: 5 } }, "local");
		await bg.flush();
		expect(bg.chrome.alarms.create).toHaveBeenCalled();
	});

	it("ignores pref changes in other storage areas", async () => {
		const bg = await loadBackground();
		await bg.send({ type: "CRYPTO_GENERATE_VEK" });
		bg.chrome.alarms.create.mockClear();
		bg.fireStorageChanged({ "pref.autoLockMinutes": { newValue: 5 } }, "sync");
		await bg.flush();
		expect(bg.chrome.alarms.create).not.toHaveBeenCalled();
	});
});

describe("sender hostname is taken from the verified sender, not the body", () => {
	it("AUTOFILL_QUERY derives the hostname from the sender origin", async () => {
		const bg = await loadBackground({ sessionSeed: { [VEK_KEY]: "SEED" } });
		await bg.send(
			{
				type: "AUTOFILL_SET_INDEX",
				payload: [{ type: "login", id: "a", hostnames: ["real.com"], name: "Real", username: "u" }],
			},
			extensionSender,
		);
		// Body claims evil.com but the sender is real.com: the tab message must be
		// for real.com's matches.
		await bg.send(
			{ type: "AUTOFILL_QUERY", hostname: "evil.com", hasLogin: true },
			pageSender("real.com", 42),
		);
		const pushed = bg.state.tabMessages.find((m) => m.message.type === "AUTOFILL_MATCHES");
		expect(pushed?.tabId).toBe(42);
		expect(pushed?.message.payload.logins).toHaveLength(1);
	});

	it("AUTOFILL_QUERY with no verifiable origin is rejected", async () => {
		const bg = await loadBackground();
		const { resp } = await bg.send({ type: "AUTOFILL_QUERY", hasLogin: true }, {});
		expect(resp).toEqual({ ok: false, error: "no verifiable origin on sender" });
	});
});
