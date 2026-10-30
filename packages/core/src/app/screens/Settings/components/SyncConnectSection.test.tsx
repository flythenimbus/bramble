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

function mount() {
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
			syncDevicePublicKey: async () => "me",
		},
		storage: {
			getMeta: async () => undefined,
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
