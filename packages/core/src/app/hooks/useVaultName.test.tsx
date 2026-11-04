/** @vitest-environment happy-dom */
import { cleanup, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type SyncedSettingsAccess, SyncedSettingsContext } from "../../hooks/synced-settings";
import type { SyncedSettings } from "../../sync";
import { useRenameVault, useVaultNameSync, VAULT_NAME_KEY } from "./useVaultName";

// The vault's name rides sync; the registry holds the copy shown while locked. These pin which
// side wins when they differ, and that nothing moves while the vault is locked.

const h = vi.hoisted(() => ({
	label: "",
	calls: [] as string[],
}));

vi.mock("../../hooks/useVaultRegistry", () => ({
	useVaultRegistry: () => ({
		activeId: "v1",
		vaults: [{ id: "v1", label: h.label, createdAt: 1 }],
		rename: async (label: string) => {
			h.calls.push(`rename:${label}`);
		},
	}),
}));

const stamp = { wall: 5, counter: 0, node: "phone" };

function access(settings: SyncedSettings | undefined, ready = true): SyncedSettingsAccess {
	return {
		settings,
		ready,
		set: async (key, value) => {
			h.calls.push(`set:${key}=${String(value)}`);
		},
	};
}

function mount(value: SyncedSettingsAccess, child: ReactNode) {
	render(<SyncedSettingsContext.Provider value={value}>{child}</SyncedSettingsContext.Provider>);
}

function Sync() {
	useVaultNameSync();
	return null;
}

beforeEach(() => {
	h.label = "";
	h.calls = [];
});
afterEach(cleanup);

describe("useVaultNameSync", () => {
	it("adopts the name another device synced", async () => {
		h.label = "Vault on this phone";
		mount(access({ [VAULT_NAME_KEY]: { hlc: stamp, value: "Family" } }), <Sync />);
		await waitFor(() => expect(h.calls).toEqual(["rename:Family"]));
	});

	it("publishes a name given before names synced, once", async () => {
		h.label = "Work";
		mount(access(undefined), <Sync />);
		await waitFor(() => expect(h.calls).toEqual([`set:${VAULT_NAME_KEY}=Work`]));
	});

	it("leaves an unnamed vault unnamed when nothing was synced", async () => {
		mount(access(undefined), <Sync />);
		await new Promise((r) => setTimeout(r, 10));
		expect(h.calls).toEqual([]);
	});

	it("does nothing while the vault is locked", async () => {
		h.label = "Work";
		mount(access({ [VAULT_NAME_KEY]: { hlc: stamp, value: "Family" } }, false), <Sync />);
		await new Promise((r) => setTimeout(r, 10));
		expect(h.calls).toEqual([]);
	});

	it("reads a cleared name as unnamed, not as never synced", async () => {
		h.label = "Work";
		mount(access({ [VAULT_NAME_KEY]: { hlc: stamp, value: null } }), <Sync />);
		await waitFor(() => expect(h.calls).toEqual(["rename:"]));
	});

	it("stays put when the two agree", async () => {
		h.label = "Family";
		mount(access({ [VAULT_NAME_KEY]: { hlc: stamp, value: "Family" } }), <Sync />);
		await new Promise((r) => setTimeout(r, 10));
		expect(h.calls).toEqual([]);
	});
});

describe("useRenameVault", () => {
	it("writes the synced name before the registry, so the sync can't put the old one back", async () => {
		let rename: ((name: string) => Promise<void>) | undefined;
		function Grab() {
			rename = useRenameVault();
			return null;
		}
		mount(access({}), <Grab />);
		await rename?.("Household");
		expect(h.calls).toEqual([`set:${VAULT_NAME_KEY}=Household`, "rename:Household"]);
	});
});
