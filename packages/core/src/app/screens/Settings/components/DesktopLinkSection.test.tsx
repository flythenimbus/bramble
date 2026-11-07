/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
	/** Vaults hidden after a combine. */
	hidden: [] as { id: string; label: string; createdAt: number; hiddenAt?: number }[],
	/** Holds an import open, to look at the screen during it. */
	importHold: null as Promise<void> | null,
	/** The app says its vault is empty, so linking combines without asking. */
	desktopEmpty: false,
	/** Ordered log of what the flow did, so ordering is assertable rather than assumed. */
	steps: [] as string[],
	imported: null as unknown[] | null,
	joinLabel: null as string | undefined | null,
	joinViaLink: undefined as boolean | undefined,
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
	/** True in the toolbar popup, false in the detached window (and off the extension). */
	canPopOut: false,
	poppedOut: 0,
	claims: 0,
	/** What desktopLink.start() resolves with. */
	startResult: { id: "L1", sas: { emoji: [0, 1, 2, 3, 4, 5, 6], digits: "1234 5678 9012" } } as
		| { id: string; sas: { emoji: number[]; digits: string } }
		| { legacy: true },
	confirms: [] as [string, boolean][],
	/** How many vaults still have a link after an unlink. */
	remaining: 0,
	syncEvent: null as ((e: { kind: string; sas?: string; sasEmoji?: number[] }) => void) | null,
}));

vi.mock("../../../hooks/usePopOut", () => ({
	usePopOut: () => ({
		canPopOut: h.canPopOut,
		popOut: () => {
			h.poppedOut++;
		},
	}),
}));

vi.mock("../../../../hooks/useVault", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../../hooks/useVault")>()),
	useVault: () => ({ entries: h.entries, files: [], conflicts: new Map() }),
	useVaultActions: () => ({
		startJoin: async (
			_code: string,
			_unlock: unknown,
			label?: string,
			opts?: { viaLink?: boolean },
		) => {
			h.joinViaLink = opts?.viaLink;
			h.steps.push("join");
			h.joinLabel = label;
			if (h.joinFails) throw new Error("join failed");
			// The desktop's vault is now the open one, as after a real join.
			h.activeVault = "joined";
			return "joined";
		},
		importEntries: async (items: unknown[]) => {
			h.steps.push("import");
			await h.importHold;
			h.imported = items;
			return [];
		},
		readEntries: () => [],
		readOpenVaultFromDisk: async () => ({
			entries: h.entries,
			files: [],
			settings: undefined,
			conflicted: 0,
			unreadable: 0,
		}),
		deleteHiddenVault: async (id: string) => {
			h.steps.push(`deleteHidden:${id}`);
			return true;
		},
		readSetting: () => undefined,
		writeSetting: async () => {},
		deleteCarriedVault: async () => {
			h.steps.push("removeOld");
			return true;
		},
	}),
}));

vi.mock("../../../../hooks/useVaultRegistry", () => ({
	useVaultRegistry: () => ({
		vaults: h.vaults,
		activeId: h.vaults.length ? h.activeVault : undefined,
		hiddenVaults: h.hidden,
		show: async (id: string) => {
			h.steps.push(`show:${id}`);
		},
		hide: async () => {
			h.steps.push("hide");
		},
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
	crypto: {},
	storage: {
		readVaultBlob: async () => new Uint8Array([1]),
		getMeta: async (key: string) => {
			if (!key.startsWith("sync.group:")) return undefined;
			const id = key.split(":")[1] ?? "";
			const group = h.groupOf.get(id);
			if (!group) return undefined;
			return {
				groupKey: group,
				roster: {
					devices: (h.rosterOf.get(id) ?? []).map((publicKey) => ({ publicKey, label: publicKey })),
				},
			};
		},
	},
	shell: {
		onSyncEvent: (cb: (e: { kind: string; sas?: string; sasEmoji?: number[] }) => void) => {
			h.syncEvent = cb;
			return () => {};
		},
	},
	desktopLink: {
		status: async () => ({ paired: h.paired, pairedAt: 1, permitted: h.permitted }),
		claimSyncInvite: async () => {
			h.claims++;
			return h.invite;
		},
		desktopSyncKey: async () => h.desktopKey,
		vaultSummary: async () => (h.desktopEmpty ? { name: "Home", empty: true, entries: 0 } : null),
		start: async () => h.startResult,
		confirm: async (id: string, matches: boolean) => {
			h.confirms.push([id, matches]);
			if (!matches) throw new Error("The symbols did not match, so nothing was linked.");
			h.paired = true;
		},
		unlink: async () => {
			h.steps.push("unlink");
			return { remaining: h.remaining };
		},
		attach: async (vaultId: string) => {
			h.steps.push(`attach:${vaultId}`);
			return true;
		},
		abandon: async () => {
			h.steps.push("abandon");
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

/** Mount a vault with no link of its own, and link it: each vault links for itself. */
async function mountAndLink() {
	h.paired = false;
	mount();
	fireEvent.click(await screen.findByRole("button", { name: /^link$/i }));
	fireEvent.click(await screen.findByRole("button", { name: /they match/i }));
}

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
	h.hidden = [];
	h.importHold = null;
	h.desktopEmpty = false;
	h.steps.length = 0;
	h.imported = null;
	h.joinLabel = null;
	h.joinViaLink = undefined;
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
	h.canPopOut = false;
	h.poppedOut = 0;
	h.claims = 0;
	h.startResult = { id: "L1", sas: { emoji: [0, 1, 2, 3, 4, 5, 6], digits: "1234 5678 9012" } };
	h.confirms = [];
	h.remaining = 0;
});

describe("what a desktop connect will do to this browser", () => {
	it("says it is only switching when this browser already shares that vault", async () => {
		// The case that read as the app swallowing the user's entries: nothing transfers and no
		// vault is created, but the user was moved into a different vault without being told.
		h.vaults = [{ id: "v1", label: "Personal", createdAt: 1 }];
		h.groupOf.set("v1", "GROUP");
		h.invite = "code";
		await mountAndLink();

		expect(await screen.findByText(/already share this vault/i)).toBeTruthy();
		expect(screen.queryByLabelText(/master password/i)).toBeNull();
	});

	it("says it stays in this vault when this vault is the one already shared", async () => {
		h.vaults = [{ id: "v1", label: "Personal", createdAt: 1 }];
		h.groupOf.set("v1", "GROUP");
		h.invite = "code";
		await mountAndLink();

		expect(await screen.findByText(/this vault already syncs with the desktop app/i)).toBeTruthy();
		expect(screen.getByRole("button", { name: /^link$/i })).toBeTruthy();
		expect(screen.queryByText(/switches you to it/i)).toBeNull();
	});

	it("offers to open the other vault when that one is already shared", async () => {
		h.vaults = [
			{ id: "v1", label: "Personal", createdAt: 1 },
			{ id: "v2", label: "Work", createdAt: 2 },
		];
		h.groupOf.set("v2", "GROUP");
		h.invite = "code";
		await mountAndLink();

		expect(await screen.findByText(/switches you to it/i)).toBeTruthy();
		expect(screen.getByRole("button", { name: /open that vault/i })).toBeTruthy();
	});

	it("asks whether to combine when both sides have entries", async () => {
		h.vaults = [{ id: "v1", label: "Personal", createdAt: 1 }];
		h.groupOf.set("v1", "OTHER-GROUP");
		h.entries = [entry("a")];
		h.invite = "code";
		await mountAndLink();

		expect(await screen.findByText(/you have two vaults/i)).toBeTruthy();
		expect(screen.getByRole("radio", { name: /combine into one/i })).toBeTruthy();
		expect(screen.getByRole("radio", { name: /keep them separate/i })).toBeTruthy();
	});

	it("lets the vault arrive under its own name", async () => {
		// The name follows the vault to every device, so nothing is named here.
		h.vaults = [{ id: "v1", label: "Personal", createdAt: 1 }];
		h.groupOf.set("v1", "OTHER-GROUP");
		h.entries = [entry("a")];
		h.invite = "code";
		await mountAndLink();
		await screen.findByText(/you have two vaults/i);

		fireEvent.click(screen.getByRole("radio", { name: /keep them separate/i }));
		fireEvent.change(screen.getByLabelText(/^master password$/i), { target: { value: "pw" } });
		fireEvent.click(screen.getByRole("button", { name: /^continue$/i }));

		await waitFor(() => expect(h.joinViaLink).toBe(true));
		expect(h.joinLabel).toBeUndefined();
	});

	it("joins over the link, never the relay", async () => {
		h.vaults = [{ id: "v1", label: "Personal", createdAt: 1 }];
		h.groupOf.set("v1", "OTHER-GROUP");
		h.entries = [entry("a")];
		h.invite = "code";
		await mountAndLink();
		await screen.findByText(/you have two vaults/i);

		fireEvent.click(screen.getByRole("radio", { name: /keep them separate/i }));
		fireEvent.change(screen.getByLabelText(/^master password$/i), { target: { value: "pw" } });
		fireEvent.click(screen.getByRole("button", { name: /^continue$/i }));

		await waitFor(() => expect(h.joinViaLink).toBe(true));
	});
});

describe("when both sides have entries", () => {
	function twoVaults() {
		h.vaults = [{ id: "v1", label: "Personal", createdAt: 1 }];
		h.groupOf.set("v1", "OTHER-GROUP");
		h.entries = [entry("a"), entry("b")];
		h.invite = "code";
	}

	async function choose(name: RegExp) {
		await mountAndLink();
		await screen.findByText(/you have two vaults/i);
		fireEvent.click(screen.getByRole("radio", { name }));
		fireEvent.change(screen.getByLabelText(/^master password$/i), { target: { value: "pw" } });
		fireEvent.click(screen.getByRole("button", { name: /^continue$/i }));
	}

	it("asks nothing about the old vault up front: that comes with the result", async () => {
		twoVaults();
		await mountAndLink();
		await screen.findByText(/you have two vaults/i);
		fireEvent.click(screen.getByRole("radio", { name: /combine into one/i }));
		expect(screen.queryByRole("checkbox")).toBeNull();
	});

	it("asks once the copy is done, and deletes the old vault only on the press", async () => {
		twoVaults();
		await choose(/combine into one/i);
		await screen.findByRole("heading", { name: /delete the old vault/i });
		expect(h.steps).toEqual(["join", "attach:joined", "import", "hide"]);

		fireEvent.click(screen.getByRole("button", { name: /^delete old vault$/i }));
		await waitFor(() => expect(h.steps).toContain("removeOld"));
		await waitFor(() =>
			expect(screen.queryByRole("heading", { name: /delete the old vault/i })).toBeNull(),
		);
	});

	it("shows that a copy is under way, and that it can't be dismissed", async () => {
		twoVaults();
		let release = () => {};
		h.importHold = new Promise((resolve) => {
			release = resolve;
		});
		await choose(/combine into one/i);
		await screen.findByText(/copying into the desktop's vault/i);
		fireEvent.keyDown(window, { key: "Escape" });
		expect(screen.getByText(/copying into the desktop's vault/i)).toBeTruthy();
		release();
		h.importHold = null;
		await screen.findByRole("heading", { name: /delete the old vault/i });
		expect(screen.queryByText(/copying into the desktop's vault/i)).toBeNull();
	});

	it("warns about other devices on the automatic combine too", async () => {
		twoVaults();
		h.rosterOf.set("v1", ["Phone"]);
		h.desktopEmpty = true;
		await mountAndLink();
		await screen.findByText(/also syncs with Phone/i);
	});

	it("keeps the old vault on Keep it, and does not ask again", async () => {
		twoVaults();
		await choose(/combine into one/i);
		await screen.findByRole("heading", { name: /delete the old vault/i });

		fireEvent.click(screen.getByRole("button", { name: /^keep it$/i }));
		await waitFor(() =>
			expect(screen.queryByRole("heading", { name: /delete the old vault/i })).toBeNull(),
		);
		expect(h.steps).not.toContain("removeOld");
	});

	it("asks nothing when the vaults stay separate", async () => {
		twoVaults();
		await choose(/keep them separate/i);
		await waitFor(() => expect(h.steps).toContain("join"));
		expect(screen.queryByRole("heading", { name: /delete the old vault/i })).toBeNull();
		expect(h.steps).not.toContain("removeOld");
	});

	it("keeps the choice for the retry after a mistyped password", async () => {
		twoVaults();
		h.joinFails = true;
		await mountAndLink();
		await screen.findByText(/you have two vaults/i);
		fireEvent.click(screen.getByRole("radio", { name: /combine into one/i }));
		fireEvent.change(screen.getByLabelText(/^master password$/i), { target: { value: "typo" } });
		fireEvent.click(screen.getByRole("button", { name: /^continue$/i }));
		await waitFor(() => expect(screen.getByText(/join failed/i)).toBeTruthy());

		h.joinFails = false;
		expect(
			(screen.getByRole("radio", { name: /combine into one/i }) as HTMLInputElement).checked,
		).toBe(true);
		fireEvent.change(screen.getByLabelText(/^master password$/i), { target: { value: "pw" } });
		fireEvent.click(screen.getByRole("button", { name: /^continue$/i }));

		await screen.findByRole("heading", { name: /delete the old vault/i });
		expect(h.steps).toContain("hide");
		expect(h.steps).not.toContain("removeOld");
	});

	it("no longer promises the old vault stays", async () => {
		twoVaults();
		await mountAndLink();
		await screen.findByText(/you have two vaults/i);
		expect(screen.queryByText(/before linking/i)).toBeNull();
	});

	it("asks combine or keep separate, with neither chosen for the user", async () => {
		twoVaults();
		await mountAndLink();
		await screen.findByText(/you have two vaults/i);

		for (const radio of screen.getAllByRole("radio"))
			expect((radio as HTMLInputElement).checked).toBe(false);
		fireEvent.change(screen.getByLabelText(/^master password$/i), { target: { value: "pw" } });
		expect(
			(screen.getByRole("button", { name: /^continue$/i }) as HTMLButtonElement).disabled,
		).toBe(true);
	});

	it("combines by copying this vault's entries in AFTER the join", async () => {
		twoVaults();
		await choose(/combine into one/i);

		// The link attaches to the vault the join opened before anything is copied into it.
		await waitFor(() => expect(h.steps.slice(0, 3)).toEqual(["join", "attach:joined", "import"]));
		expect(h.imported).toHaveLength(2);
		expect(h.imported?.[0]).not.toHaveProperty("id");
	});

	it("keeps them separate by copying nothing", async () => {
		twoVaults();
		await choose(/keep them separate/i);

		await waitFor(() => expect(h.steps).toEqual(["join", "attach:joined"]));
		expect(h.imported).toBeNull();
	});

	it("copies nothing when the join fails, leaving the originals where they are", async () => {
		twoVaults();
		h.joinFails = true;
		await choose(/combine into one/i);

		await waitFor(() => expect(screen.getByText(/join failed/i)).toBeTruthy());
		expect(h.steps).toEqual(["join"]);
		expect(h.imported).toBeNull();
	});
});

describe("a vault left hidden by a closed dialog", () => {
	const hidden = { id: "old", label: "Personal", createdAt: 1, hiddenAt: 5 };

	it("is asked about again in Settings, by name, with both answers", async () => {
		h.vaults = [{ id: "v2", label: "Home", createdAt: 2 }];
		h.hidden = [hidden];
		h.entries = [];
		mount();
		await screen.findByText(/Personal is hidden on this browser/i);
		expect(screen.getByRole("button", { name: /^keep it$/i })).toBeTruthy();
		expect(screen.getByRole("button", { name: /^delete$/i })).toBeTruthy();
	});

	it("is listed again on Keep it", async () => {
		h.vaults = [{ id: "v2", label: "Home", createdAt: 2 }];
		h.hidden = [hidden];
		h.steps = [];
		mount();
		fireEvent.click(await screen.findByRole("button", { name: /^keep it$/i }));
		await waitFor(() => expect(h.steps).toContain("show:old"));
		expect(h.steps).not.toContain("deleteHidden:old");
	});

	it("is deleted only after confirming", async () => {
		h.vaults = [{ id: "v2", label: "Home", createdAt: 2 }];
		h.hidden = [hidden];
		h.steps = [];
		mount();
		fireEvent.click(await screen.findByRole("button", { name: /^delete$/i }));
		expect(h.steps).not.toContain("deleteHidden:old");
		fireEvent.click(await screen.findByRole("button", { name: /^delete it$/i }));
		await waitFor(() => expect(h.steps).toContain("deleteHidden:old"));
	});

	it("asks nothing with none hidden", async () => {
		h.vaults = [{ id: "v2", label: "Home", createdAt: 2 }];
		h.hidden = [];
		mount();
		await waitFor(() => expect(screen.queryByText(/is hidden on this browser/i)).toBeNull());
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

	it("offers no Link again and names no other vault: each vault's link is its own", async () => {
		// Linking again replaced the profile's one link, so another vault lost its pairing.
		h.vaults = [{ id: "v1", label: "Personal", createdAt: 1 }];
		h.groupOf.set("v1", "GROUP");
		h.rosterOf.set("v1", ["browser-key"]);
		h.desktopKey = "desktop-key";
		mount();

		expect(await screen.findByText(/^Linked /i)).toBeTruthy();
		expect(screen.queryByText(/shares a different vault/i)).toBeNull();
		expect(screen.queryByRole("button", { name: /^link again$/i })).toBeNull();
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

	it("keeps the permission while another vault still has a link", async () => {
		h.askable = true;
		h.remaining = 1;
		mount();

		fireEvent.click(await screen.findByRole("button", { name: /disconnect/i }));
		fireEvent.click(await screen.findByRole("button", { name: /stop using the app/i }));

		await waitFor(() => expect(h.steps).toEqual(["unlink"]));
		await new Promise((r) => setTimeout(r, 20));
		expect(h.steps).toEqual(["unlink"]);
	});

	it("stays out of the way where the host has no permission to ask for", async () => {
		// Mobile and desktop hold it from install. Absent must read as allowed, or the section
		// would offer a grant button on hosts with nothing to grant.
		h.paired = false;
		h.askable = false;
		mount();

		expect(await screen.findByRole("button", { name: /^link$/i })).toBeTruthy();
		expect(screen.queryByRole("button", { name: /allow and continue/i })).toBeNull();
	});
});

// Confirming a join means switching to the desktop app, which closes the toolbar popup and loses the
// vault it was receiving. Claiming spends the invite, so the window has to come first.
describe("in the toolbar popup", () => {
	it("continues in a window instead of pairing there", async () => {
		h.paired = false;
		h.canPopOut = true;
		mount();
		fireEvent.click(await screen.findByRole("button", { name: "Continue in a window" }));
		expect(h.poppedOut).toBe(1);
		expect(screen.queryByLabelText("Pairing code")).toBeNull();
	});

	it("leaves an invite unclaimed for the window, and offers it", async () => {
		h.paired = false;
		h.canPopOut = true;
		h.invite = "INVITE";
		mount();
		expect(await screen.findByRole("button", { name: "Continue in a window" })).toBeTruthy();
		await new Promise((r) => setTimeout(r, 50));
		expect(h.claims).toBe(0);
		expect(screen.queryByText("Add the desktop's vault")).toBeNull();
	});

	it("offers nothing more once this vault already syncs with the app", async () => {
		h.canPopOut = true;
		h.desktopKey = "APP";
		h.rosterOf.set("v1", ["APP"]);
		h.groupOf.set("v1", "GROUP");
		mount();
		expect(await screen.findByText("This vault syncs with the desktop app.")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Continue in a window" })).toBeNull();
	});
});

describe("linking by emoji", () => {
	it("shows the symbols, and claims the desktop's vault once both screens confirm", async () => {
		h.paired = false;
		h.invite = "code";
		mount();
		fireEvent.click(await screen.findByRole("button", { name: /^link$/i }));
		expect(await screen.findByText("1234 5678 9012")).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: /they match/i }));

		await waitFor(() => expect(h.confirms).toEqual([["L1", true]]));
		expect(await screen.findByText(/sync with the desktop app/i)).toBeTruthy();
	});

	it("offers the code for a desktop app that predates the emoji", async () => {
		h.paired = false;
		h.startResult = { legacy: true };
		mount();
		fireEvent.click(await screen.findByRole("button", { name: /^link$/i }));

		expect(await screen.findByLabelText(/code from the desktop app/i)).toBeTruthy();
	});

	it("links nothing when the symbols do not match", async () => {
		h.paired = false;
		mount();
		fireEvent.click(await screen.findByRole("button", { name: /^link$/i }));
		fireEvent.click(await screen.findByRole("button", { name: /don't match/i }));

		await waitFor(() => expect(h.confirms).toEqual([["L1", false]]));
		expect(await screen.findByText(/nothing was linked/i)).toBeTruthy();
		expect(h.claims).toBe(0);
	});
});

describe("an older desktop app's copy", () => {
	it("shows the symbols it asks to compare", async () => {
		h.vaults = [{ id: "v1", label: "Personal", createdAt: 1 }];
		h.groupOf.set("v1", "OTHER-GROUP");
		h.entries = [entry("a")];
		h.invite = "code";
		await mountAndLink();
		await screen.findByText(/you have two vaults/i);
		act(() =>
			h.syncEvent?.({ kind: "sas", sas: "1234 5678 9012", sasEmoji: [0, 1, 2, 3, 4, 5, 6] }),
		);
		expect(await screen.findByText(/approve only if they match/i)).toBeTruthy();
	});
});

describe("a pairing is never half made", () => {
	it("offers no Not now: closing the vault's offer lets the link go", async () => {
		h.vaults = [{ id: "v1", label: "Personal", createdAt: 1 }];
		h.invite = "INVITE";
		await mountAndLink();
		expect(await screen.findByText(/sync with the desktop app/i)).toBeTruthy();
		expect(screen.queryByRole("button", { name: /not now/i })).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: /^close$/i }));

		await waitFor(() => expect(h.steps).toContain("abandon"));
	});

	it("offers Try again beside a claim that brought no vault, and claims again", async () => {
		h.vaults = [{ id: "v1", label: "Personal", createdAt: 1 }];
		h.invite = null;
		await mountAndLink();
		expect(await screen.findByText(/didn't send its vault/i)).toBeTruthy();

		h.invite = "INVITE";
		fireEvent.click(screen.getByRole("button", { name: /try again/i }));

		expect(await screen.findByText(/sync with the desktop app/i)).toBeTruthy();
		expect(h.claims).toBe(2);
	});
});
