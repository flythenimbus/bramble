import { CRYPTO_SESSION_CHANGED } from "@core/adapters/crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	autofillSessionCapability,
	defaultOffscreen,
	extensionSender,
	loadBackground,
	pageSender,
	setAutofillIndex,
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

	it.each(["CRYPTO_GENERATE_VEK", "CRYPTO_UNWRAP_PASSWORD_SLOT"])(
		"does not resurrect a VEK or broadcast unlocked when held %s completes after lock",
		async (type) => {
			let release: ((response: ReturnType<typeof defaultOffscreen>) => void) | undefined;
			const bg = await loadBackground({
				offscreen: (message) =>
					message.type === type
						? new Promise((resolve) => {
								release = resolve;
							})
						: defaultOffscreen(message),
				openTabs: [{ id: 1 }],
			});
			const pending = bg.send({ type });
			await bg.flush();
			expect(release).toBeTypeOf("function");

			await bg.send({ type: "CRYPTO_LOCK" });
			release?.(defaultOffscreen({ type }));
			expect((await pending).resp).toEqual({ ok: false, error: CRYPTO_SESSION_CHANGED });
			expect(bg.state.session[VEK_KEY]).toBeUndefined();
			expect(
				bg.state.tabMessages.filter(
					(message) =>
						message.message.type === "VAULT_LOCK_STATE" && message.message.payload.locked === false,
				),
			).toHaveLength(0);
		},
	);

	it("serializes a held VEK persistence commit behind a later lock and rolls it back", async () => {
		const bg = await loadBackground({ openTabs: [{ id: 1 }] });
		const originalSet = bg.chrome.storage.session.set;
		let releaseSet: (() => void) | undefined;
		bg.chrome.storage.session.set = vi.fn((value: Record<string, unknown>) => {
			if (VEK_KEY in value) {
				return new Promise<void>((resolve) => {
					releaseSet = resolve;
				});
			}
			return originalSet(value);
		});

		const unlock = bg.send({ type: "CRYPTO_UNLOCK_WITH_VEK", payload: { vekB64: "LATE" } });
		await bg.flush();
		expect(releaseSet).toBeTypeOf("function");
		const lock = bg.send({ type: "CRYPTO_LOCK" });
		await bg.flush();
		releaseSet?.();
		expect((await unlock).resp).toEqual({ ok: false, error: CRYPTO_SESSION_CHANGED });
		await lock;
		expect(bg.state.session[VEK_KEY]).toBeUndefined();
		const session = await import("./session");
		expect(session.vaultLocked()).toBe(true);
	});

	it("does not invalidate an unlock or its index lease when delayed active-id notification repeats a refresh", async () => {
		const bg = await loadBackground({ deferSessionStorageChanges: true });
		// The shell write resolves first, as Chrome permits; its onChanged notification remains
		// queued while the background refreshes the same value before starting the unwrap.
		await bg.chrome.storage.session.set({ "vault.activeId": "v2" });
		const unlocked = await bg.send({ type: "CRYPTO_UNWRAP_PASSWORD_SLOT" });
		expect(unlocked.resp).toEqual({ ok: true, data: true });
		const lease = await autofillSessionCapability(bg);

		bg.flushSessionStorageChanges();
		expect(await autofillSessionCapability(bg)).toEqual(lease);
		expect(
			(
				await bg.send(
					{
						type: "AUTOFILL_SET_INDEX",
						payload: { entries: [], owner: lease },
					},
					extensionSender,
				)
			).resp,
		).toEqual({ ok: true, data: null });
	});

	it("consumes a delayed local lock removal before a same-vault reactivation event", async () => {
		const bg = await loadBackground({
			sessionSeed: { [VEK_KEY]: "SEED" },
			deferSessionStorageChanges: true,
			openTabs: [{ id: 1 }],
		});
		await bg.send({ type: "CRYPTO_LOCK" });
		// The picker immediately chooses the same vault again. The background refresh sees the new
		// value before either delayed storage event is delivered and installs a fresh VEK under it.
		await bg.chrome.storage.session.set({ "vault.activeId": "v1" });
		expect((await bg.send({ type: "CRYPTO_UNWRAP_PASSWORD_SLOT" })).resp).toEqual({
			ok: true,
			data: true,
		});
		await bg.flush();
		const lease = await autofillSessionCapability(bg);
		expect(bg.state.alarms[AUTOLOCK]).toBeDefined();

		// Deliver the old clearAllVeks removal, then the new UI set: this is the harmful ordering
		// value-only deduplication could not distinguish. The old event is consumed by its local
		// receipt; the new same-value event is a harmless no-op.
		bg.flushSessionStorageChanges();
		expect(await autofillSessionCapability(bg)).toEqual(lease);
		expect((await bg.send({ type: "CRYPTO_IS_LOCKED" })).resp).toEqual({ ok: true, data: false });
		expect(
			(
				await bg.send(
					{ type: "AUTOFILL_SET_INDEX", payload: { entries: [], owner: lease } },
					extensionSender,
				)
			).resp,
		).toEqual({ ok: true, data: null });
		expect(
			bg.state.tabMessages.some(
				(message) =>
					message.message.type === "VAULT_LOCK_STATE" && message.message.payload.locked === false,
			),
		).toBe(true);
	});

	it("reports a failed stale-install rollback instead of treating it as a clean session change", async () => {
		const bg = await loadBackground();
		const originalSet = bg.chrome.storage.session.set;
		const originalRemove = bg.chrome.storage.session.remove;
		let releaseSet: (() => void) | undefined;
		let failRollbackRemove = true;
		bg.chrome.storage.session.set = vi.fn((value: Record<string, unknown>) => {
			if (VEK_KEY in value) {
				void originalSet(value); // model a browser commit whose completion is delayed
				return new Promise<void>((resolve) => {
					releaseSet = resolve;
				});
			}
			return originalSet(value);
		});
		bg.chrome.storage.session.remove = vi.fn((keys: string | string[]) => {
			const list = Array.isArray(keys) ? keys : [keys];
			if (failRollbackRemove && list.includes(VEK_KEY)) {
				failRollbackRemove = false;
				return Promise.reject(new Error("rollback remove rejected"));
			}
			return originalRemove(keys);
		});

		const unlock = bg.send({ type: "CRYPTO_UNLOCK_WITH_VEK", payload: { vekB64: "LATE" } });
		await bg.flush();
		const lock = bg.send({ type: "CRYPTO_LOCK" });
		await bg.flush();
		releaseSet?.();
		expect((await unlock).resp).toMatchObject({
			ok: false,
			error: expect.stringContaining("rollback"),
		});
		// The queued full lock retries cleanup after the failed rollback; this is not an orphan that
		// can reappear when a worker starts again.
		await lock;
		await bg.flush();
		expect(bg.state.session[VEK_KEY]).toBeUndefined();
	});

	it("reports a rejected MRU write while rolling back a stale install", async () => {
		const bg = await loadBackground();
		const originalSet = bg.chrome.storage.session.set;
		let releaseSet: (() => void) | undefined;
		let rejectRollbackMru = true;
		bg.chrome.storage.session.set = vi.fn((value: Record<string, unknown>) => {
			if (VEK_KEY in value) {
				void originalSet(value);
				return new Promise<void>((resolve) => {
					releaseSet = resolve;
				});
			}
			if (rejectRollbackMru && "vault.unlockedMru" in value) {
				rejectRollbackMru = false;
				return Promise.reject(new Error("rollback MRU write rejected"));
			}
			return originalSet(value);
		});

		const unlock = bg.send({ type: "CRYPTO_UNLOCK_WITH_VEK", payload: { vekB64: "LATE" } });
		await bg.flush();
		const lock = bg.send({ type: "CRYPTO_LOCK" });
		await bg.flush();
		releaseSet?.();
		expect((await unlock).resp).toMatchObject({
			ok: false,
			error: expect.stringContaining("rollback"),
		});
		await lock;
		expect(bg.state.session[VEK_KEY]).toBeUndefined();
	});

	it("fails a full lock whose durable cleanup is rejected and a restart still refuses the orphan", async () => {
		const bg = await loadBackground({
			sessionSeed: { [VEK_KEY]: "SEED", "vault.vek:orphan": "ORPHAN", "vault.unlockedMru": ["v1"] },
		});
		const originalRemove = bg.chrome.storage.session.remove;
		bg.chrome.storage.session.remove = vi.fn((keys: string | string[]) => {
			const list = Array.isArray(keys) ? keys : [keys];
			return list.includes(VEK_KEY)
				? Promise.reject(new Error("full lock remove rejected"))
				: originalRemove(keys);
		});

		const locked = await bg.send({ type: "CRYPTO_LOCK" });
		expect(locked.resp).toMatchObject({
			ok: false,
			error: expect.stringContaining("lock cleanup"),
		});
		const session = await import("./session");
		expect(session.vaultLocked()).toBe(true);

		// A durable lock marker was written before removal. A fresh worker treats retained VEK keys
		// as cleanup residue rather than an unlocked session, then removes them when storage works.
		const restarted = await loadBackground({ sessionSeed: { ...bg.state.session } });
		const restartedSession = await import("./session");
		expect(restartedSession.vaultLocked()).toBe(true);
		expect(restarted.state.session[VEK_KEY]).toBeUndefined();
		expect(restarted.state.session["vault.vek:orphan"]).toBeUndefined();
		expect(restarted.state.session["vault.activeId"]).toBeUndefined();
	});

	it("reports a rejected lock marker write even when the best-effort key removal succeeds", async () => {
		const bg = await loadBackground({ sessionSeed: { [VEK_KEY]: "SEED" } });
		const originalSet = bg.chrome.storage.session.set;
		bg.chrome.storage.session.set = vi.fn((value: Record<string, unknown>) =>
			"vault.vek.locked" in value
				? Promise.reject(new Error("lock marker write rejected"))
				: originalSet(value),
		);

		const locked = await bg.send({ type: "CRYPTO_LOCK" });
		expect(locked.resp).toMatchObject({
			ok: false,
			error: expect.stringContaining("lock cleanup"),
		});
		expect(bg.state.session[VEK_KEY]).toBeUndefined();
		const restarted = await loadBackground({ sessionSeed: { ...bg.state.session } });
		const restartedSession = await import("./session");
		expect(restartedSession.vaultLocked()).toBe(true);
		expect(restarted.state.session[VEK_KEY]).toBeUndefined();
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

	it("the auto-lock alarm still zeroizes offscreen when durable VEK cleanup rejects", async () => {
		const bg = await loadBackground({ sessionSeed: { [VEK_KEY]: "SEED" } });
		const originalRemove = bg.chrome.storage.session.remove;
		bg.chrome.storage.session.remove = vi.fn((keys: string | string[]) => {
			const list = Array.isArray(keys) ? keys : [keys];
			return list.includes(VEK_KEY)
				? Promise.reject(new Error("auto-lock cleanup rejected"))
				: originalRemove(keys);
		});

		bg.fireAlarm(AUTOLOCK);
		await bg.flush();
		expect(bg.state.offscreenCalls.map((m) => m.type)).toContain("CRYPTO_LOCK");
		const session = await import("./session");
		expect(session.vaultLocked()).toBe(true);
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

	it("suppresses a held older unlock broadcast after a later lock", async () => {
		const bg = await loadBackground({ openTabs: [{ id: 1 }] });
		let releaseFirstQuery: (() => void) | undefined;
		let queryCount = 0;
		bg.chrome.tabs.query = vi.fn(() =>
			queryCount++ === 0
				? new Promise((resolve) => {
						releaseFirstQuery = () => resolve([{ id: 1 }]);
					})
				: Promise.resolve([{ id: 1 }]),
		);
		const unlock = bg.send({ type: "CRYPTO_GENERATE_VEK" });
		await bg.flush();
		expect(releaseFirstQuery).toBeTypeOf("function");
		await bg.send({ type: "CRYPTO_LOCK" });
		releaseFirstQuery?.();
		await unlock;
		await bg.flush();
		expect(
			lockStateMsgs(bg).filter((message) => message.message.payload.locked === false),
		).toHaveLength(0);
	});
});

describe("vault lock state drives query results", () => {
	it("an unlocked index serves matches; a lock makes the same query report locked", async () => {
		const bg = await loadBackground({ sessionSeed: { [VEK_KEY]: "SEED" } });
		await setAutofillIndex(bg, [
			{ type: "login", id: "a", hostnames: ["example.com"], name: "Example", username: "u" },
		]);
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
		await setAutofillIndex(bg, [
			{ type: "login", id: "a", hostnames: ["real.com"], name: "Real", username: "u" },
		]);
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
		await setAutofillIndex(bg, [
			{
				type: "login",
				id: "login",
				hostnames: ["example.com"],
				name: "Example",
				username: "alice",
				password: "secret",
			},
		]);
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
		// The handler reads storage.local more than once (the autofill switch, then the auto-lock
		// timeout); hand the rest back to the real area or the held select never returns.
		bg.chrome.storage.local.get = originalGet;
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
