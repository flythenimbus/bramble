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

const h = vi.hoisted(() => ({
	hasPasswordSlot: true,
	inviteDevice: vi.fn(),
	navigate: vi.fn(),
	verifyMasterPassword: vi.fn(),
	setMeta: vi.fn(async () => {}),
	removeMeta: vi.fn(async () => {}),
}));
vi.mock("../../../../hooks/useVault", () => ({
	useVault: () => ({ hasPasswordSlot: h.hasPasswordSlot }),
	useVaultActions: () => ({
		inviteDevice: h.inviteDevice,
		removeDevice: vi.fn(),
		verifyMasterPassword: h.verifyMasterPassword,
	}),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => h.navigate }));
vi.mock("../../../../hooks/useVaultRegistry", () => ({
	useVaultRegistry: () => ({ syncKey: (k: string) => k }),
}));

afterEach(() => {
	cleanup();
	h.hasPasswordSlot = true;
	h.inviteDevice.mockClear();
	h.navigate.mockClear();
	h.setMeta.mockClear();
	h.removeMeta.mockClear();
});

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});

function mount(
	opts: {
		group?: unknown;
		syncDevicePublicKey?: () => Promise<string>;
		synced?: SyncedSettingsAccess;
		syncNow?: () => Promise<void>;
	} = {},
) {
	const listeners: ((e: SyncEvent) => void)[] = [];
	const statusListeners: ((s: string, at: number) => void)[] = [];
	const approveEnrollment = vi.fn(async (_approved: boolean) => {});
	const platform = {
		target: "desktop",
		shell: {
			onSyncEvent: (cb: (e: SyncEvent) => void) => {
				listeners.push(cb);
				return () => {};
			},
			onSyncStatus: (cb: (s: string, at: number) => void) => {
				statusListeners.push(cb);
				return () => {};
			},
			syncNow: opts.syncNow,
			getPendingEnrollApproval: async () => null,
			approveEnrollment,
			stopEnrollInvite: async () => {},
			syncDevicePublicKey: opts.syncDevicePublicKey ?? (async () => "me"),
		},
		storage: {
			getMeta: async (k: string) => (k === "sync.group" ? opts.group : undefined),
			setMeta: h.setMeta,
			removeMeta: h.removeMeta,
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
	const status = (s: string, at = Date.now()) =>
		act(() => {
			for (const cb of statusListeners) cb(s, at);
		});
	return { emit, status, approveEnrollment };
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

// Pairing hands over the vault, and the re-entered master password is what signs the new device in.
describe("adding a device without a master password", () => {
	it("asks for a master password first instead of pairing", async () => {
		h.hasPasswordSlot = false;
		mount();
		fireEvent.click(await screen.findByRole("button", { name: "Add a device" }));

		expect(await screen.findByText(/Adding a device needs a master password/)).toBeTruthy();
		expect(h.inviteDevice).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Turn on master password" }));
		expect(h.navigate).toHaveBeenCalledWith(
			expect.objectContaining({ to: "/settings", search: { tab: "security" } }),
		);
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

// People send this log with bug reports, and the desktop app lets nothing be selected by default.
describe("the sync log", () => {
	it("copies every line, dated, with the button in its corner", async () => {
		const writeText = vi.fn(async (_text: string) => {});
		Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
		const { status } = mount({ group: groupOf("me", "peer") });
		status("relay connected (nostr.example.com)", new Date(2025, 0, 2, 3, 4, 5).getTime());
		status("ignored bad-signature event from b941d388", new Date(2025, 0, 2, 3, 4, 6).getTime());

		fireEvent.click(await screen.findByRole("button", { name: "Copy log" }));

		expect(writeText).toHaveBeenCalledWith(
			"2025-01-02 03:04:05 relay connected (nostr.example.com)\n" +
				"2025-01-02 03:04:06 ignored bad-signature event from b941d388",
		);
	});

	// Issue #230: a log with no times could cover a minute or an hour.
	it("shows when each line was logged, with the date only for an earlier day", async () => {
		const { status } = mount({ group: groupOf("me", "peer") });
		status("relay connected (nostr.example.com)");
		status("reconnecting to the relay…", new Date(2025, 0, 2, 3, 4, 5).getTime());

		const today = await screen.findByText("relay connected (nostr.example.com)");
		expect(today.previousElementSibling?.textContent).toMatch(/^\d\d:\d\d:\d\d$/);
		const earlier = screen.getByText("reconnecting to the relay…");
		expect(earlier.previousElementSibling?.textContent).toBe("2025-01-02 03:04:05");
	});

	// Issue #230: a device in the group should be called by its name, not just its key.
	it("names the devices it mentions on screen, but not in a copy", async () => {
		const writeText = vi.fn(async (_text: string) => {});
		Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
		const PEER = "tG/Lnb18xYz+abcdefghijklmnopqrstuvwxyz012345=";
		const { status } = mount({
			group: {
				groupKey: "g",
				roster: {
					devices: [device("me"), { ...device(PEER), label: "Alice's iPad" }],
					revoked: [],
				},
			},
		});
		status("synced with tG/Lnb18 ✅", new Date(2025, 0, 2, 3, 4, 5).getTime());

		expect(await screen.findByText("synced with tG/Lnb18 (Alice's iPad) ✅")).toBeTruthy();
		// Copies end up in public bug reports.
		fireEvent.click(screen.getByRole("button", { name: "Copy log" }));
		expect(writeText).toHaveBeenCalledWith("2025-01-02 03:04:05 synced with tG/Lnb18 ✅");
	});

	it("can be selected on the desktop", async () => {
		const { status } = mount({ group: groupOf("me", "peer") });
		status("relay connected (nostr.example.com)");
		const line = await screen.findByText("relay connected (nostr.example.com)");
		expect(line.closest("[data-selectable]")).toBeTruthy();
	});

	it("isn't shown, and offers nothing to copy, before anything is logged", async () => {
		mount({ group: groupOf("me", "peer") });
		await screen.findByText("Synced · 2 devices");
		expect(screen.queryByRole("button", { name: "Copy log" })).toBeNull();
	});
});

// Issue #230: the only way to retry was to lock and unlock.
describe("sync now", () => {
	it("restarts sync, and can't be pressed again until that's done", async () => {
		let finish = () => {};
		const syncNow = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
		mount({ group: groupOf("me", "peer"), syncNow });

		const button = (await screen.findByRole("button", { name: "Sync now" })) as HTMLButtonElement;
		fireEvent.click(button);
		expect(syncNow).toHaveBeenCalledTimes(1);
		expect(button.disabled).toBe(true);

		await act(async () => finish());
		expect(button.disabled).toBe(false);
	});

	it("says in the log when the restart fails", async () => {
		mount({
			group: groupOf("me", "peer"),
			syncNow: async () => {
				throw new Error("unlock this vault first");
			},
		});
		fireEvent.click(await screen.findByRole("button", { name: "Sync now" }));
		expect(await screen.findByText("error: unlock this vault first")).toBeTruthy();
	});

	it("isn't offered with no other device to sync with", async () => {
		mount({ group: groupOf("me"), syncNow: async () => {} });
		await screen.findByText("Waiting for a device to join…");
		expect(screen.queryByRole("button", { name: "Sync now" })).toBeNull();
	});

	it("isn't offered while this device can't sync", async () => {
		mount({ group: groupOf("old-me", "peer"), syncNow: async () => {} });
		await screen.findByText(/no longer recognize this one/);
		expect(screen.queryByRole("button", { name: "Sync now" })).toBeNull();
	});

	it("isn't offered where the app can't restart sync", async () => {
		mount({ group: groupOf("me", "peer") });
		await screen.findByText("Synced · 2 devices");
		expect(screen.queryByRole("button", { name: "Sync now" })).toBeNull();
	});
});

// A name given on any device is a synced setting, so every device in the group shows it. The
// device's own default stays in its roster entry, which only it can sign.
// The field saves as you type and shows the hosted relay when nothing is saved. A saved blank looked
// like the default and stopped sync on the desktop and iOS, with a message that named nothing.
describe("the relay setting", () => {
	const relayField = async () => {
		fireEvent.click(await screen.findByRole("button", { name: "Advanced" }));
		return screen.findByLabelText("Nostr relay URL");
	};

	it("forgets the relay when the field is cleared", async () => {
		mount({ group: groupOf("me", "other") });
		fireEvent.change(await relayField(), { target: { value: "" } });

		expect(h.removeMeta).toHaveBeenCalledWith("sync.relay");
		expect(h.setMeta).not.toHaveBeenCalledWith("sync.relay", expect.anything());
	});

	it("treats a field of spaces as cleared", async () => {
		mount({ group: groupOf("me", "other") });
		fireEvent.change(await relayField(), { target: { value: "   " } });

		expect(h.removeMeta).toHaveBeenCalledWith("sync.relay");
	});

	it("saves a relay without the spaces around it", async () => {
		mount({ group: groupOf("me", "other") });
		fireEvent.change(await relayField(), { target: { value: " wss://relay.example.com " } });

		expect(h.setMeta).toHaveBeenCalledWith("sync.relay", "wss://relay.example.com");
		expect(h.removeMeta).not.toHaveBeenCalledWith("sync.relay");
	});

	it("invites over the hosted relay with the field cleared", async () => {
		h.verifyMasterPassword.mockResolvedValueOnce(true);
		h.inviteDevice.mockResolvedValueOnce("bramble-pair-1.x");
		mount({ group: groupOf("me", "other") });
		fireEvent.change(await relayField(), { target: { value: "" } });

		fireEvent.click(screen.getByRole("button", { name: "Add another device" }));
		fireEvent.change(await screen.findByLabelText("Master password"), {
			target: { value: "pw" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Continue" }));

		await vi.waitFor(() => expect(h.inviteDevice).toHaveBeenCalled());
		expect(h.inviteDevice.mock.calls[0]?.[0]).toBe("wss://bramble-relay.flythenimbus.workers.dev");
	});
});

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
