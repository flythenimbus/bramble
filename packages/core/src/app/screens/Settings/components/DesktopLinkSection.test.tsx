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
	paired: true,
	/** What status() reports. Undefined is a host that does not answer the question at all. */
	permitted: undefined as boolean | undefined,
	/** Whether the host has a runtime permission to ask for. Mobile and desktop do not. */
	askable: false,
	granted: true,
	requestGrants: true,
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
		status: async () => ({ paired: h.paired, pairedAt: 1, permitted: h.permitted }),
		claimSyncInvite: async () => h.invite,
		desktopSyncKey: async () => h.desktopKey,
		unlink: async () => {
			h.steps.push("unlink");
		},
		// A getter, so a test can model a host with no runtime permission to ask for.
		get permission() {
			return h.askable
				? {
						granted: async () => h.granted,
						request: async () => {
							h.steps.push("request");
							return h.requestGrants;
						},
						drop: async () => {
							h.steps.push("drop");
						},
					}
				: undefined;
		},
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
	h.paired = true;
	h.permitted = undefined;
	h.askable = false;
	h.granted = true;
	h.requestGrants = true;
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

describe("disconnecting", () => {
	it("says what stopping the app link does not do, before doing it", async () => {
		// "Disconnect" can mean two different things and only one of them is this. Stopping the
		// link is local and reversible; taking the browser out of the vault is a roster change
		// every device sees, and it lives elsewhere. Confusing them either silently evicts a
		// browser from sync or leaves a user thinking they removed something they did not.
		h.vaults = [{ id: "v1", label: "Personal", createdAt: 1 }];
		mount();
		fireEvent.click(await screen.findByRole("button", { name: /disconnect/i }));

		expect(screen.getByText(/keeps syncing with it/i)).toBeTruthy();
		expect(screen.getByText(/remove it from the device list/i)).toBeTruthy();
		// And it has not happened yet: the wording is there to be read first.
		expect(screen.getByRole("button", { name: /stop using the app/i })).toBeTruthy();
	});

	it("can be backed out of", async () => {
		h.vaults = [{ id: "v1", label: "Personal", createdAt: 1 }];
		mount();
		fireEvent.click(await screen.findByRole("button", { name: /disconnect/i }));
		fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

		expect(screen.queryByText(/keeps syncing with it/i)).toBeNull();
	});
});

// The permission the link needs is asked for here rather than granted at install, so the section
// has three states this suite did not previously have: not yet allowed, allowed, and allowed-then-
// revoked. The last is the dangerous one, because the pairing survives it and the link looks fine.
describe("the browser permission the link needs", () => {
	/** happy-dom's reload would navigate; the assertion is only that it was reached. */
	function stubReload() {
		const reload = vi.fn();
		Object.defineProperty(window, "location", {
			configurable: true,
			value: { ...window.location, reload },
		});
		return reload;
	}

	it("asks for permission instead of offering the code field", async () => {
		h.paired = false;
		h.askable = true;
		h.granted = false;
		mount();

		expect(await screen.findByRole("button", { name: /allow and continue/i })).toBeTruthy();
		// Offering the code first would walk the user into a pairing that cannot complete.
		expect(screen.queryByLabelText(/pairing code/i)).toBeNull();
	});

	it("reloads after a grant, because the context that asked never gains the API", async () => {
		const reload = stubReload();
		h.paired = false;
		h.askable = true;
		h.granted = false;
		mount();

		fireEvent.click(await screen.findByRole("button", { name: /allow and continue/i }));

		// Chromium fixes bindings at context creation. Pairing without this would reach for a
		// connectNative that this page will never have.
		await waitFor(() => expect(reload).toHaveBeenCalled());
		expect(h.steps).toEqual(["request"]);
	});

	it("does not reload when the user declines", async () => {
		const reload = stubReload();
		h.paired = false;
		h.askable = true;
		h.granted = false;
		h.requestGrants = false;
		mount();

		fireEvent.click(await screen.findByRole("button", { name: /allow and continue/i }));

		expect(await screen.findByText(/needs that permission/i)).toBeTruthy();
		expect(reload).not.toHaveBeenCalled();
	});

	it("shows the link as still linked when the permission was revoked, not as disconnected", async () => {
		// The keys are intact, so this is one grant away from working. Reading it as
		// "disconnected" would push the user into re-pairing, which needs a fresh code from a
		// desktop app they would have to go and open.
		h.askable = true;
		h.permitted = false;
		mount();

		expect(await screen.findByText(/permission needed/i)).toBeTruthy();
		expect(await screen.findByText(/still linked/i)).toBeTruthy();
		expect(screen.queryByText(/^Connected$/)).toBeNull();
	});

	it("hands the permission back when the link is removed", async () => {
		h.askable = true;
		mount();

		fireEvent.click(await screen.findByRole("button", { name: /disconnect/i }));
		fireEvent.click(await screen.findByRole("button", { name: /stop using the app/i }));

		// Order matters: the unlink is the thing the user asked for, and dropping the permission
		// must not be able to prevent it.
		await waitFor(() => expect(h.steps).toEqual(["unlink", "drop"]));
	});

	it("stays out of the way where the host has no permission to ask for", async () => {
		// Mobile and desktop hold it from install. Absent must read as allowed, or the section
		// would offer a grant button on hosts with nothing to grant.
		h.paired = false;
		h.askable = false;
		mount();

		expect(await screen.findByLabelText(/pairing code/i)).toBeTruthy();
		expect(screen.queryByRole("button", { name: /allow and continue/i })).toBeNull();
	});
});
