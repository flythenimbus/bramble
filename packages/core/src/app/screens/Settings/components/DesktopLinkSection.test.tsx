/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type Platform, PlatformProvider } from "../../../../context/PlatformContext";
import type { Entry } from "../../../../hooks/useVault";
import { DesktopLinkSection } from "./DesktopLinkSection";

// Connecting a browser to the desktop app can leave the user standing in a different vault than
// the one they started in. What is under test is that the flow says which of the three things it
// is about to do, and that carrying entries across happens in an order that cannot lose them.

const h = vi.hoisted(() => ({
	entries: [] as Entry[],
	vaults: [] as { id: string; label: string; createdAt: number }[],
	groupOf: new Map<string, string>(),
	/** Ordered log of what the flow did, so ordering is assertable rather than assumed. */
	steps: [] as string[],
	imported: null as unknown[] | null,
	joinLabel: null as string | undefined | null,
	joinFails: false,
	invite: null as string | null,
	activeVault: "v1",
	/** The app's sync device key, and which vaults have it in their roster. */
	desktopKey: null as string | null,
	rosterOf: new Map<string, string[]>(),
}));

vi.mock("../../../../hooks/useVault", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../../hooks/useVault")>()),
	useVault: () => ({ entries: h.entries }),
	useVaultActions: () => ({
		startJoin: async (_code: string, _unlock: unknown, label?: string) => {
			h.steps.push("join");
			h.joinLabel = label;
			if (h.joinFails) throw new Error("join failed");
		},
		importEntries: async (items: unknown[]) => {
			h.steps.push("import");
			h.imported = items;
		},
	}),
}));

vi.mock("../../../../hooks/useVaultRegistry", () => ({
	useVaultRegistry: () => ({
		vaults: h.vaults,
		syncKey: (k: string) => `${k}:${h.activeVault}`,
	}),
}));

// A code carrying a known group, so the "already sharing" check has something to match.
vi.mock("../../../../sync/enrollment", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../../sync/enrollment")>()),
	decodePairingCode: () => ({ groupKey: "GROUP" }),
}));

const platform = {
	target: "chromium",
	storage: {
		getMeta: async (key: string) => {
			const id = key.split(":")[1] ?? "";
			const group = h.groupOf.get(id);
			if (!group) return undefined;
			return {
				groupKey: group,
				roster: { devices: (h.rosterOf.get(id) ?? []).map((publicKey) => ({ publicKey })) },
			};
		},
	},
	shell: { onSyncEvent: () => () => {} },
	desktopLink: {
		status: async () => ({ paired: true, pairedAt: 1 }),
		claimSyncInvite: async () => h.invite,
		desktopSyncKey: async () => h.desktopKey,
		unlink: async () => {},
	},
} as unknown as Platform;

const entry = (id: string): Entry =>
	({ id, kind: "login", name: id, username: "u", password: "p", urls: [] }) as unknown as Entry;

function mount() {
	return render(
		<I18nProvider i18n={i18n}>
			<PlatformProvider platform={platform}>
				<DesktopLinkSection />
			</PlatformProvider>
		</I18nProvider>,
	);
}

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});

afterEach(() => {
	cleanup();
	h.entries = [];
	h.vaults = [];
	h.groupOf.clear();
	h.steps.length = 0;
	h.imported = null;
	h.joinLabel = null;
	h.joinFails = false;
	h.invite = null;
	h.activeVault = "v1";
	h.desktopKey = null;
	h.rosterOf.clear();
});

describe("what a desktop connect will do to this browser", () => {
	it("says it is only switching when this browser already shares that vault", async () => {
		// The case that read as the app swallowing the user's entries: nothing transfers and no
		// vault is created, but the user was moved into a different vault without being told.
		h.vaults = [{ id: "v1", label: "Personal", createdAt: 1 }];
		h.groupOf.set("v1", "GROUP");
		h.invite = "code";
		mount();

		expect(await screen.findByText(/already share this vault/i)).toBeTruthy();
		expect(screen.queryByLabelText(/master password/i)).toBeNull();
	});

	it("says a second vault is being added, and why they cannot be combined", async () => {
		h.vaults = [{ id: "v1", label: "Personal", createdAt: 1 }];
		h.groupOf.set("v1", "OTHER-GROUP");
		h.invite = "code";
		mount();

		expect(await screen.findByText(/add the desktop's vault/i)).toBeTruthy();
		expect(screen.getByText(/existing vaults stay as they are/i)).toBeTruthy();
	});

	it("names the vault it creates after the desktop app", async () => {
		// A blank "Vault 2" appearing mid-flow is what made this feel like data loss.
		h.vaults = [{ id: "v1", label: "Personal", createdAt: 1 }];
		h.groupOf.set("v1", "OTHER-GROUP");
		h.invite = "code";
		mount();
		await screen.findByText(/add the desktop's vault/i);

		fireEvent.change(screen.getByLabelText(/master password/i), { target: { value: "pw" } });
		fireEvent.click(screen.getByRole("button", { name: /^sync$/i }));

		await waitFor(() => expect(h.joinLabel).toBe("Desktop vault"));
	});
});

describe("carrying this vault's entries across", () => {
	it("is not offered when there is nothing to carry", async () => {
		h.vaults = [{ id: "v1", label: "Personal", createdAt: 1 }];
		h.groupOf.set("v1", "OTHER-GROUP");
		h.invite = "code";
		mount();
		await screen.findByText(/add the desktop's vault/i);

		expect(screen.queryByRole("checkbox")).toBeNull();
	});

	it("copies the entries in AFTER the join, so they land in the new vault", async () => {
		// Order is the whole correctness argument: the two vaults have different keys and only one
		// is loaded at a time, so the entries are read while this vault is open and written once
		// the other one is. Importing first would put them back where they already were.
		h.vaults = [{ id: "v1", label: "Personal", createdAt: 1 }];
		h.groupOf.set("v1", "OTHER-GROUP");
		h.entries = [entry("a"), entry("b")];
		h.invite = "code";
		mount();
		await screen.findByText(/add the desktop's vault/i);

		fireEvent.click(screen.getByRole("checkbox"));
		fireEvent.change(screen.getByLabelText(/master password/i), { target: { value: "pw" } });
		fireEvent.click(screen.getByRole("button", { name: /^sync$/i }));

		await waitFor(() => expect(h.steps).toEqual(["join", "import"]));
		expect(h.imported).toHaveLength(2);
	});

	it("strips the ids, so the copies are new entries rather than claims on the originals", async () => {
		h.vaults = [{ id: "v1", label: "Personal", createdAt: 1 }];
		h.groupOf.set("v1", "OTHER-GROUP");
		h.entries = [entry("a")];
		h.invite = "code";
		mount();
		await screen.findByText(/add the desktop's vault/i);

		fireEvent.click(screen.getByRole("checkbox"));
		fireEvent.change(screen.getByLabelText(/master password/i), { target: { value: "pw" } });
		fireEvent.click(screen.getByRole("button", { name: /^sync$/i }));

		await waitFor(() => expect(h.imported).not.toBeNull());
		expect(h.imported?.[0]).not.toHaveProperty("id");
	});

	it("copies nothing when the box is left unticked", async () => {
		h.vaults = [{ id: "v1", label: "Personal", createdAt: 1 }];
		h.groupOf.set("v1", "OTHER-GROUP");
		h.entries = [entry("a")];
		h.invite = "code";
		mount();
		await screen.findByText(/add the desktop's vault/i);

		fireEvent.change(screen.getByLabelText(/master password/i), { target: { value: "pw" } });
		fireEvent.click(screen.getByRole("button", { name: /^sync$/i }));

		await waitFor(() => expect(h.steps).toEqual(["join"]));
		expect(h.imported).toBeNull();
	});

	it("copies nothing when the join fails, leaving the originals where they are", async () => {
		// The safe way round: a failed join must not scatter copies into a vault that was never
		// built, and the entries are still in the vault they came from either way.
		h.vaults = [{ id: "v1", label: "Personal", createdAt: 1 }];
		h.groupOf.set("v1", "OTHER-GROUP");
		h.entries = [entry("a")];
		h.invite = "code";
		h.joinFails = true;
		mount();
		await screen.findByText(/add the desktop's vault/i);

		fireEvent.click(screen.getByRole("checkbox"));
		fireEvent.change(screen.getByLabelText(/master password/i), { target: { value: "pw" } });
		fireEvent.click(screen.getByRole("button", { name: /^sync$/i }));

		await waitFor(() => expect(screen.getByText(/join failed/i)).toBeTruthy());
		expect(h.steps).toEqual(["join"]);
		expect(h.imported).toBeNull();
	});
});

describe("whether the vault on screen is the one the app shares", () => {
	it("says so when the app's device is in this vault's roster", async () => {
		h.vaults = [{ id: "v1", label: "Personal", createdAt: 1 }];
		h.groupOf.set("v1", "GROUP");
		h.rosterOf.set("v1", ["desktop-key", "browser-key"]);
		h.desktopKey = "desktop-key";
		mount();

		expect(await screen.findByText(/this vault syncs with the desktop app/i)).toBeTruthy();
	});

	it("says the app shares a different vault when its device is absent here", async () => {
		// The bug: the link is per-BROWSER and a sync group is per-VAULT, so "Connected" was true
		// of the browser while implying something about whichever vault you were standing in.
		h.vaults = [{ id: "v1", label: "Personal", createdAt: 1 }];
		h.groupOf.set("v1", "GROUP");
		h.rosterOf.set("v1", ["browser-key"]);
		h.desktopKey = "desktop-key";
		mount();

		expect(await screen.findByText(/shares a different vault/i)).toBeTruthy();
	});

	it("claims nothing when the app is not running to answer", async () => {
		// Not derived from the live sync session for this reason: a closed app would otherwise
		// make a perfectly good pairing read as "not shared".
		h.vaults = [{ id: "v1", label: "Personal", createdAt: 1 }];
		h.groupOf.set("v1", "GROUP");
		h.rosterOf.set("v1", ["desktop-key"]);
		h.desktopKey = null;
		mount();

		expect(await screen.findByText(/^Linked /i)).toBeTruthy();
		expect(screen.queryByText(/shares a different vault/i)).toBeNull();
		expect(screen.queryByText(/this vault syncs with/i)).toBeNull();
	});
});
