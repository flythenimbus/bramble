/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SyncEvent } from "../../../../adapters/shell";
import { type Platform, PlatformProvider } from "../../../../context/PlatformContext";
import {
	type SyncedSettingsAccess,
	SyncedSettingsContext,
} from "../../../../hooks/synced-settings";
import type { SyncedSettings } from "../../../../sync";
import { deviceNameKey } from "../../../hooks/useDeviceNames";
import { SyncConnectSection } from "./SyncConnectSection";

vi.mock("../../../../hooks/useVault", () => ({
	useVault: () => ({ hasPasswordSlot: true }),
	useVaultActions: () => ({
		inviteDevice: vi.fn(),
		removeDevice: vi.fn(),
		verifyMasterPassword: vi.fn(),
	}),
}));
vi.mock("../../../../hooks/useVaultRegistry", () => ({
	useVaultRegistry: () => ({ syncKey: (k: string) => k }),
}));

afterEach(cleanup);

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});

function mount(
	opts: {
		group?: unknown;
		syncDevicePublicKey?: () => Promise<string>;
		synced?: SyncedSettingsAccess;
	} = {},
) {
	const listeners: ((e: SyncEvent) => void)[] = [];
	const approveEnrollment = vi.fn(async (_approved: boolean) => {});
	const platform = {
		target: "desktop",
		shell: {
			onSyncEvent: (cb: (e: SyncEvent) => void) => {
				listeners.push(cb);
				return () => {};
			},
			onSyncStatus: () => () => {},
			getPendingEnrollApproval: async () => null,
			approveEnrollment,
			stopEnrollInvite: async () => {},
			syncDevicePublicKey: opts.syncDevicePublicKey ?? (async () => "me"),
		},
		storage: {
			getMeta: async (k: string) => (k === "sync.group" ? opts.group : undefined),
			setMeta: async () => {},
			removeMeta: async () => {},
			subscribeMeta: () => () => {},
		},
	} as unknown as Platform;
	const section = opts.synced ? (
		<SyncedSettingsContext.Provider value={opts.synced}>
			<SyncConnectSection />
		</SyncedSettingsContext.Provider>
	) : (
		<SyncConnectSection />
	);
	render(
		<I18nProvider i18n={i18n}>
			<PlatformProvider platform={platform}>{section}</PlatformProvider>
		</I18nProvider>,
	);
	const emit = (e: SyncEvent) =>
		act(() => {
			for (const cb of listeners) cb(e);
		});
	return { emit, approveEnrollment };
}

const APPROVAL = {
	kind: "enroll-approval",
	sas: "123456789012",
	sasEmoji: [1, 2, 3, 4, 5, 6],
	label: "Firefox",
} as SyncEvent;

// The desktop's browser link arms its own invite, and its prompt lands here too.
describe("the approval prompt", () => {
	it("is not refused because an earlier invite expired", async () => {
		const { emit, approveEnrollment } = mount();
		emit({ kind: "enroll-expired" } as SyncEvent);
		emit(APPROVAL);

		expect(await screen.findByText("Is this your device?")).toBeTruthy();
		expect(approveEnrollment).not.toHaveBeenCalledWith(false);
	});

	it("goes away when its own invite expires", async () => {
		const { emit } = mount();
		emit(APPROVAL);
		expect(await screen.findByText("Is this your device?")).toBeTruthy();

		emit({ kind: "enroll-expired" } as SyncEvent);
		expect(screen.queryByText("Is this your device?")).toBeNull();
	});
});

const device = (publicKey: string) => ({
	id: publicKey,
	publicKey,
	label: publicKey,
	addedAt: 1,
	hlc: { wall: 1, counter: 0, node: publicKey },
});
const groupOf = (...keys: string[]) => ({
	groupKey: "g",
	roster: { devices: keys.map(device), revoked: [] },
});

// Peers check this device's key against rosters copied from its own, so a device missing from its
// own list can neither sync nor pair. Saying "Synced" there hid a user's broken sync for 20 days.
describe("the sync status", () => {
	it("says synced while the group knows this device", async () => {
		mount({ group: groupOf("me", "peer") });
		expect(await screen.findByText("Synced · 2 devices")).toBeTruthy();
	});

	it("says not syncing when the group no longer knows this device's key", async () => {
		mount({ group: groupOf("old-me", "peer") });
		expect(await screen.findByText(/no longer recognize this one/)).toBeTruthy();
		expect(screen.queryByText(/^Synced/)).toBeNull();
		const add = screen.getByRole("button", { name: /Add another device/ }) as HTMLButtonElement;
		expect(add.disabled).toBe(true);
	});

	it("says not syncing when this device can't read its sync key", async () => {
		mount({
			group: groupOf("me", "peer"),
			syncDevicePublicKey: async () => {
				throw new Error("this device's sync key can't be read");
			},
		});
		expect(await screen.findByText(/can't read its sync key right now/)).toBeTruthy();
		expect(screen.queryByText(/^Synced/)).toBeNull();
	});
});

// A name given on any device is a synced setting, so every device in the group shows it. The
// device's own default stays in its roster entry, which only it can sign.
describe("device names", () => {
	const STAMP = { wall: 5, counter: 0, node: "me" };
	function synced(settings: SyncedSettings | undefined, ready = true) {
		const writes: [string, unknown][] = [];
		const access: SyncedSettingsAccess = {
			settings,
			ready,
			set: async (key, value) => {
				writes.push([key, value]);
			},
		};
		return { access, writes };
	}
	const rename = async (device: string, typed: string, key: string) => {
		fireEvent.click(await screen.findByRole("button", { name: `Rename ${device}` }));
		const field = screen.getByLabelText("Device name");
		fireEvent.change(field, { target: { value: typed } });
		fireEvent.keyDown(field, { key });
	};

	it("shows the name a device was given over its own", async () => {
		const { access } = synced({ [deviceNameKey("peer")]: { hlc: STAMP, value: "Work laptop" } });
		mount({ group: groupOf("me", "peer"), synced: access });
		expect(await screen.findByText("Work laptop")).toBeTruthy();
		expect(screen.queryByText("peer")).toBeNull();
		expect(screen.getByRole("button", { name: "Remove Work laptop" })).toBeTruthy();
	});

	it("shows the device's own name again once the given one is cleared", async () => {
		const { access } = synced({ [deviceNameKey("peer")]: { hlc: STAMP, value: null } });
		mount({ group: groupOf("me", "peer"), synced: access });
		expect(await screen.findByText("peer")).toBeTruthy();
	});

	it("names any device in the group, this one included", async () => {
		const { access, writes } = synced(undefined);
		mount({ group: groupOf("me", "peer"), synced: access });
		await rename("peer", "  Work laptop ", "Enter");
		await rename("me", "Phone", "Enter");
		expect(writes).toEqual([
			[deviceNameKey("peer"), "Work laptop"],
			[deviceNameKey("me"), "Phone"],
		]);
	});

	it("clears the name when the field is emptied, and keeps it on Escape", async () => {
		const { access, writes } = synced({
			[deviceNameKey("peer")]: { hlc: STAMP, value: "Work laptop" },
		});
		mount({ group: groupOf("me", "peer"), synced: access });
		await rename("Work laptop", "Desk", "Escape");
		expect(writes).toEqual([]);
		await rename("Work laptop", "", "Enter");
		expect(writes).toEqual([[deviceNameKey("peer"), null]]);
	});

	it("writes nothing when the name is left as it was", async () => {
		const { access, writes } = synced(undefined);
		mount({ group: groupOf("me", "peer"), synced: access });
		await rename("peer", "peer", "Enter");
		expect(writes).toEqual([]);
	});

	it("offers no rename while the vault's settings can't be written", async () => {
		const { access } = synced(undefined, false);
		mount({ group: groupOf("me", "peer"), synced: access });
		expect(await screen.findByText("peer")).toBeTruthy();
		expect(screen.queryByRole("button", { name: /^Rename/ })).toBeNull();
	});
});
