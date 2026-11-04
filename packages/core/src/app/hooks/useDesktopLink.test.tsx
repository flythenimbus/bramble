/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { type Platform, PlatformProvider } from "../../context/PlatformContext";
import { useDesktopLink } from "./useDesktopLink";

// The one link flow behind both the setup banner and Settings: emoji, then what the desktop vault
// holds, then its invite, then what joining does to this browser.

const h = vi.hoisted(() => ({
	calls: [] as string[],
	joins: [] as unknown[][],
	vaults: [] as { id: string; label: string; createdAt: number }[],
	summary: { name: "Home", empty: false, entries: 380 } as unknown,
	start: { id: "L1", sas: { emoji: [0, 1, 2, 3, 4, 5, 6], digits: "1" } } as unknown,
}));

vi.mock("../../hooks/useVault", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../hooks/useVault")>()),
	useVault: () => ({ entries: [] }),
	useVaultActions: () => ({
		startJoin: async (...args: unknown[]) => {
			h.joins.push(args);
		},
		importEntries: async () => {},
	}),
}));

vi.mock("../../hooks/useVaultRegistry", () => ({
	useVaultRegistry: () => ({ vaults: h.vaults, activeId: h.vaults[0]?.id }),
}));

vi.mock("../../sync/enrollment", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../sync/enrollment")>()),
	decodePairingCode: () => ({ groupKey: "GROUP" }),
}));

const platform = {
	storage: { getMeta: async () => undefined },
	shell: { onSyncEvent: () => () => {} },
	desktopLink: {
		status: async () => ({ paired: true }),
		start: async () => h.start,
		confirm: async () => {
			h.calls.push("confirm");
		},
		vaultSummary: async () => {
			h.calls.push("summary");
			return h.summary;
		},
		claimSyncInvite: async () => {
			h.calls.push("claim");
			return "invite";
		},
	},
} as unknown as Platform;

const wrapper = ({ children }: { children: ReactNode }) => (
	<I18nProvider i18n={i18n}>
		<PlatformProvider platform={platform}>{children}</PlatformProvider>
	</I18nProvider>
);

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});

async function linkedFrom(from: "setup" | "settings" | "add") {
	const { result } = renderHook(() => useDesktopLink({ from }), { wrapper });
	await act(async () => {
		await result.current.start();
	});
	await act(async () => {
		await result.current.answer(true);
	});
	return result;
}

describe("useDesktopLink", () => {
	it("takes the desktop's vault on a first run, under its own name, over the link", async () => {
		h.vaults = [];
		h.joins = [];
		const result = await linkedFrom("setup");
		expect(result.current.outcome).toBe("take");

		await act(async () => {
			await result.current.accept("pw");
		});
		expect(h.joins).toEqual([
			["invite", { kind: "password", password: "pw" }, undefined, { viaLink: true }],
		]);
	});

	it("asks what the desktop vault holds before claiming its invite", async () => {
		h.vaults = [];
		h.calls = [];
		await linkedFrom("setup");
		expect(h.calls).toEqual(["confirm", "summary", "claim"]);
	});

	it("falls back to the code for a desktop app that predates the emoji", async () => {
		h.start = { legacy: true };
		const { result } = renderHook(() => useDesktopLink({ from: "setup" }), { wrapper });
		await act(async () => {
			await result.current.start();
		});
		expect(result.current.legacy).toBe(true);
		h.start = { id: "L1", sas: { emoji: [0, 1, 2, 3, 4, 5, 6], digits: "1" } };
	});
});
