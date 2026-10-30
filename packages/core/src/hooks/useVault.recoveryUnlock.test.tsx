/** @vitest-environment happy-dom */
import { act, cleanup, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Platform } from "../context/PlatformContext";
import { mountVault } from "../test/vault-harness";
import { VAULT_REGISTRY_KEY } from "../vault/vault-registry";

afterEach(cleanup);

// A recovery-code unlock usually means a forgotten password, so the session remembers how it was
// opened (Settings asks for the code instead of the password) and can re-check the code without
// unlocking. Each recovery slot is told apart by its salt's first byte; the code is its "password".

const CODES = ["AAAAA", "BBBBB"];

const slot = (kind: number, tag: number) => ({
	kind,
	slotId: new Uint8Array(16),
	salt: new Uint8Array(16).fill(tag),
	verifier: new Uint8Array(32),
	wrapIv: new Uint8Array(12),
	wrappedVek: new Uint8Array(32),
});

vi.mock("../vault-format", async (importOriginal) => ({
	...(await importOriginal<typeof import("../vault-format")>()),
	decodeVaultBlob: () => ({
		// Password slot (tag 9) first, then two recovery slots (tags 0 and 1).
		slots: [slot(0x01, 9), slot(0x03, 0), slot(0x03, 1)],
		entriesIv: new Uint8Array(12),
		entriesCiphertext: new Uint8Array(0),
	}),
}));

// Base64 of a 16-byte salt filled with `tag`, for matching a slot from the adapter's input.
const saltOf = (tag: number) => btoa(String.fromCharCode(...new Uint8Array(16).fill(tag)));

function makePlatform() {
	let locked = true;
	const opens = (i: { password: string; saltB64: string }) =>
		i.saltB64 === saltOf(9)
			? i.password === "master"
			: CODES.some((c, tag) => i.saltB64 === saltOf(tag) && i.password === c);
	const verifyPasswordSlot = vi.fn(async (i: { password: string; saltB64: string }) => opens(i));
	const meta = new Map<string, unknown>([
		[VAULT_REGISTRY_KEY, { vaults: [{ id: "v1", label: "", createdAt: 1 }] }],
	]);
	const platform = {
		target: "chromium",
		storage: {
			getMeta: async (k: string) => meta.get(k),
			setMeta: async (k: string, v: unknown) => void meta.set(k, v),
			removeMeta: async (k: string) => void meta.delete(k),
			hasVault: async () => true,
			readVaultBlob: async () => new Uint8Array([1]),
		},
		crypto: {
			isLocked: async () => locked,
			onExternalLock: () => () => {},
			onExternalChange: () => () => {},
			unwrapVekPassword: async (i: { password: string; saltB64: string }) => {
				if (opens(i)) locked = false;
				return !locked;
			},
			verifyPasswordSlot,
			decryptEntries: async () => [],
			lock: async () => {
				locked = true;
			},
		},
		autofill: { clearIndex: async () => {}, setIndex: async () => {} },
		shell: {
			setActiveVault: async () => {},
			onSyncStatus: () => () => {},
			flushPendingCornerCapture: async () => false,
		},
		clipboard: {},
	} as unknown as Platform;
	return { platform, verifyPasswordSlot };
}

async function mountReady() {
	const { platform, verifyPasswordSlot } = makePlatform();
	const vault = mountVault(platform);
	await waitFor(() => expect(vault.state().ready).toBe(true));
	return { ...vault, verifyPasswordSlot };
}

describe("unlockedWithRecoveryCode", () => {
	it("is set by a recovery-code unlock and cleared by the next lock", async () => {
		const { actions, state } = await mountReady();
		expect(state().unlockedWithRecoveryCode).toBe(false);

		await act(() => actions().unlockWithRecoveryCode("bbbbb"));
		expect(state().isLocked).toBe(false);
		expect(state().unlockedWithRecoveryCode).toBe(true);

		await act(() => actions().lock());
		expect(state().unlockedWithRecoveryCode).toBe(false);
	});

	it("stays false for a master-password unlock", async () => {
		const { actions, state } = await mountReady();
		await act(() => actions().unlock("master"));
		expect(state().isLocked).toBe(false);
		expect(state().unlockedWithRecoveryCode).toBe(false);
	});
});

describe("verifyRecoveryCode", () => {
	it("accepts the code of any recovery slot, normalized, without unlocking", async () => {
		const { actions, state } = await mountReady();
		// Second recovery slot, typed in lowercase with a separator.
		expect(await actions().verifyRecoveryCode("bbb-bb")).toBe(true);
		expect(state().isLocked).toBe(true);
	});

	it("rejects a wrong code, and the master password", async () => {
		const { actions, verifyPasswordSlot } = await mountReady();
		expect(await actions().verifyRecoveryCode("CCCCC")).toBe(false);
		expect(await actions().verifyRecoveryCode("master")).toBe(false);
		// Only the recovery slots are tried: the password slot never sees a recovery code.
		for (const [input] of verifyPasswordSlot.mock.calls) {
			expect(input.saltB64).not.toBe(saltOf(9));
		}
	});
});
