import { afterEach, describe, expect, it, vi } from "vitest";
import {
	defaultOffscreen,
	extensionSender,
	loadBackground,
	pageSender,
	TEST_VEK_KEY,
} from "../test/test-harness";

afterEach(() => {
	vi.unstubAllGlobals();
});

// The active vault's cached-vek session key (per-vault now). The background caches under the
// active vault id the harness seeds; see docs/multiple-vaults.md "Per-vault VEK".
const VEK_KEY = TEST_VEK_KEY;
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
		// The recovered vek rides back in the unwrap reply (no separate EXPORT_VEK round-trip) and
		// is cached under the active vault; the caller still sees only the boolean.
		expect(bg.state.session[VEK_KEY]).toBe("VEK_EXPORTED");
		expect(bg.state.alarms[AUTOLOCK]).toBeDefined();
		expect(bg.state.offscreenCalls.map((m) => m.type)).not.toContain("CRYPTO_EXPORT_VEK");
	});

	it("CRYPTO_UNWRAP_PASSWORD_SLOT (verifier miss) does not unlock", async () => {
		const bg = await loadBackground({
			offscreen: (msg) =>
				msg.type === "CRYPTO_UNWRAP_PASSWORD_SLOT"
					? { ok: true, data: { ok: false } }
					: { ok: true, data: null },
		});
		const { resp } = await bg.send({ type: "CRYPTO_UNWRAP_PASSWORD_SLOT" });
		expect(resp).toEqual({ ok: true, data: false });
		expect(bg.state.session[VEK_KEY]).toBeUndefined();
		expect(bg.state.alarms[AUTOLOCK]).toBeUndefined();
		expect(bg.state.offscreenCalls.map((m) => m.type)).not.toContain("CRYPTO_EXPORT_VEK");
	});

	it("CRYPTO_UNWRAP_WEBAUTHN_SLOT (verifier match) unlocks by exporting the VEK", async () => {
		// Regression: the webauthn slot had no branch in cryptoHandler, so a security-key
		// unlock never cached the VEK and the background reported the vault locked.
		const bg = await loadBackground({
			offscreen: (msg) =>
				msg.type === "CRYPTO_UNWRAP_WEBAUTHN_SLOT"
					? { ok: true, data: { ok: true, vekB64: "VEK_EXPORTED" } }
					: { ok: true, data: null },
		});
		const { resp } = await bg.send({ type: "CRYPTO_UNWRAP_WEBAUTHN_SLOT" });
		expect(resp).toEqual({ ok: true, data: true });
		// The recovered vek rides back in the unwrap reply and is cached, like a password unlock.
		expect(bg.state.session[VEK_KEY]).toBe("VEK_EXPORTED");
		expect(bg.state.alarms[AUTOLOCK]).toBeDefined();
		expect(bg.state.offscreenCalls.map((m) => m.type)).not.toContain("CRYPTO_EXPORT_VEK");
	});

	it("CRYPTO_UNWRAP_WEBAUTHN_SLOT (verifier miss) does not unlock", async () => {
		const bg = await loadBackground({
			offscreen: (msg) =>
				msg.type === "CRYPTO_UNWRAP_WEBAUTHN_SLOT"
					? { ok: true, data: { ok: false } }
					: { ok: true, data: null },
		});
		const { resp } = await bg.send({ type: "CRYPTO_UNWRAP_WEBAUTHN_SLOT" });
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

	it("OS screen-lock is a no-op when 'Lock when the screen locks' is off", async () => {
		const bg = await loadBackground({ localSeed: { "pref.lockOnScreenLock": false } });
		await bg.send({ type: "CRYPTO_GENERATE_VEK" });
		bg.fireIdle("locked");
		await bg.flush();
		// The vault stays unlocked: the pref opts out of the screen-lock floor (issue #6).
		expect(bg.state.session[VEK_KEY]).toBe("VEK_GENERATED");
		expect(bg.state.offscreenCalls.map((m) => m.type)).not.toContain("CRYPTO_LOCK");
	});
});

describe("lock-state broadcast to content scripts", () => {
	const lockStateMsgs = (bg: Awaited<ReturnType<typeof loadBackground>>) =>
		bg.state.tabMessages.filter((m) => m.message?.type === "VAULT_LOCK_STATE");

	it("a lock pushes VAULT_LOCK_STATE(true) to every open tab", async () => {
		const bg = await loadBackground({ openTabs: [{ id: 1 }, { id: 2 }] });
		await bg.send({ type: "CRYPTO_GENERATE_VEK" });
		await bg.send({ type: "CRYPTO_LOCK" });
		await bg.flush();
		// The unlock (generate) also broadcasts false; scope this to the lock's true pushes.
		const locked = lockStateMsgs(bg).filter((m) => m.message.payload.locked === true);
		expect(locked.map((m) => m.tabId).sort()).toEqual([1, 2]);
	});

	it("an unlock pushes VAULT_LOCK_STATE(false)", async () => {
		const bg = await loadBackground({ openTabs: [{ id: 5 }] });
		await bg.send({ type: "CRYPTO_UNWRAP_PASSWORD_SLOT" });
		await bg.flush();
		const msgs = lockStateMsgs(bg);
		expect(msgs).toHaveLength(1);
		expect(msgs[0]).toMatchObject({ tabId: 5, message: { payload: { locked: false } } });
	});

	it("tabs without a content script (rejected sendMessage) don't throw", async () => {
		const bg = await loadBackground({ openTabs: [{ id: 9 }] });
		bg.chrome.tabs.sendMessage = vi.fn(async () => {
			throw new Error("Receiving end does not exist");
		});
		await bg.send({ type: "CRYPTO_GENERATE_VEK" });
		// A locking path must still complete cleanly despite the per-tab rejection.
		const { resp } = await bg.send({ type: "CRYPTO_LOCK" });
		await bg.flush();
		expect(resp).toEqual({ ok: true, data: null });
		expect(bg.state.session[VEK_KEY]).toBeUndefined();
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
		// Body claims evil.com but the sender is real.com: only real.com's summaries
		// return on the initiating response channel (never as a tab/frame push).
		const { resp } = await bg.send(
			{ type: "AUTOFILL_QUERY", hostname: "evil.com", hasLogin: true },
			pageSender("real.com", 42),
		);
		expect(resp.data.logins).toHaveLength(1);
		expect(bg.state.tabMessages.find((m) => m.message.type === "AUTOFILL_MATCHES")).toBeUndefined();
	});

	it("AUTOFILL_QUERY with no verifiable origin is rejected", async () => {
		const bg = await loadBackground();
		const { resp } = await bg.send({ type: "AUTOFILL_QUERY", hasLogin: true }, {});
		expect(resp).toEqual({ ok: false, error: "forbidden" });
	});
});

describe("autofill session transition ordering", () => {
	async function unlockedWithLogin(options: Parameters<typeof loadBackground>[0] = {}) {
		const bg = await loadBackground({ sessionSeed: { [VEK_KEY]: "SEED" }, ...options });
		await bg.send(
			{
				type: "AUTOFILL_SET_INDEX",
				payload: [
					{
						type: "login",
						id: "login",
						hostnames: ["example.com"],
						name: "Example",
						username: "alice",
						password: "secret",
					},
				],
			},
			extensionSender,
		);
		return bg;
	}

	it.each([
		["CRYPTO_GENERATE_VEK", {}],
		["CRYPTO_UNWRAP_PASSWORD_SLOT", {}],
		["CRYPTO_UNWRAP_WEBAUTHN_SLOT", {}],
		["CRYPTO_ROTATE_VEK", {}],
	] as const)("rejects select while %s is awaiting the VEK seam", async (type, extra) => {
		let release: ((response: ReturnType<typeof defaultOffscreen>) => void) | undefined;
		const bg = await unlockedWithLogin({
			offscreen: (message) =>
				message.type === type
					? new Promise((resolve) => {
							release = resolve;
						})
					: defaultOffscreen(message),
		});
		const transition = bg.send({ type, ...extra });
		await bg.flush();
		expect(release).toBeTypeOf("function");
		const select = await bg.send(
			{ type: "AUTOFILL_SELECT", payload: { entryId: "login" } },
			pageSender("example.com", 1),
		);
		expect(select.resp).toEqual({ ok: false, error: "unavailable" });
		release?.(defaultOffscreen({ type }));
		await transition;
	});

	it("rejects select while UNLOCK_WITH_VEK has made the VEK visible but its storage write is held", async () => {
		const bg = await unlockedWithLogin();
		const originalSet = bg.chrome.storage.session.set;
		let release: (() => void) | undefined;
		bg.chrome.storage.session.set = vi.fn((value: Record<string, unknown>) => {
			if (VEK_KEY in value) {
				return new Promise<void>((resolve) => {
					release = resolve;
				});
			}
			return originalSet(value);
		});
		const transition = bg.send({ type: "CRYPTO_UNLOCK_WITH_VEK", payload: { vekB64: "NEW" } });
		await bg.flush();
		expect(release).toBeTypeOf("function");
		const select = await bg.send(
			{ type: "AUTOFILL_SELECT", payload: { entryId: "login" } },
			pageSender("example.com", 1),
		);
		expect(select.resp).toEqual({ ok: false, error: "unavailable" });
		release?.();
		await transition;
	});

	it("rejects a select held across an active-vault session replacement", async () => {
		const bg = await unlockedWithLogin();
		const originalGet = bg.chrome.storage.local.get;
		let release: ((value: unknown) => void) | undefined;
		bg.chrome.storage.local.get = vi.fn(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		);
		const select = bg.send(
			{ type: "AUTOFILL_SELECT", payload: { entryId: "login" } },
			pageSender("example.com", 1),
		);
		await bg.flush();
		expect(release).toBeTypeOf("function");
		bg.fireStorageChanged(
			{ "vault.activeId": { oldValue: "v1", newValue: "replacement" } },
			"session",
		);
		release?.(await originalGet(["pref.autoLockMinutes"]));
		expect((await select).resp).toEqual({ ok: false, error: "unavailable" });
	});

	it("initiates the lock broadcast before deferred session cleanup resolves", async () => {
		const bg = await unlockedWithLogin({ openTabs: [{ id: 1 }] });
		const session = await import("./session");
		let release!: () => void;
		const heldCleanup = new Promise<void>((resolve) => {
			release = resolve;
		});
		bg.chrome.storage.session.remove = vi.fn(() => heldCleanup);
		const clearing = session.clearSession();
		await bg.flush();
		expect(
			bg.state.tabMessages.some(
				(message) => message.message.type === "VAULT_LOCK_STATE" && message.message.payload.locked,
			),
		).toBe(true);
		release?.();
		await clearing;
	});
});
