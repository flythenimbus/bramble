/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SyncEvent } from "../../../../adapters/shell";
import { type Platform, PlatformProvider } from "../../../../context/PlatformContext";
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

function mount(opts: { group?: unknown; syncDevicePublicKey?: () => Promise<string> } = {}) {
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
	render(
		<I18nProvider i18n={i18n}>
			<PlatformProvider platform={platform}>
				<SyncConnectSection />
			</PlatformProvider>
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
