/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act, renderHook } from "@testing-library/react";
import { type ReactNode, useSyncExternalStore } from "react";
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
	steps: [] as string[],
	entries: [] as unknown[],
	files: [] as unknown[],
	desktopEntries: [] as unknown[],
	imported: [] as unknown[][],
	failStage: false,
	meta: new Map<string, unknown>(),
	joinFails: false,
	importFails: false,
	/** The open vault, as the provider sees it. Unset means the first vault in `vaults`. */
	active: undefined as string | undefined,
	subs: new Set<() => void>(),
}));

/** The open vault, re-rendering subscribers when a join switches it, as the provider does. */
function useActive(): string | undefined {
	return useSyncExternalStore(
		(cb) => {
			h.subs.add(cb);
			return () => h.subs.delete(cb);
		},
		() => h.active ?? h.vaults[0]?.id,
	);
}

function switchTo(id: string) {
	h.active = id;
	for (const cb of h.subs) cb();
}

vi.mock("../../hooks/useVault", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../hooks/useVault")>()),
	useVault: () => ({ entries: h.entries, files: h.files }),
	// Like the real provider, each action is bound to the vault open when it was made.
	useVaultActions: () => {
		const at = useActive();
		return {
			startJoin: async (...args: unknown[]) => {
				h.steps.push("join");
				h.joins.push(args);
				if (h.joinFails) throw new Error("join failed");
				switchTo("new");
			},
			importEntries: async (items: unknown[], attachments: unknown[] = []) => {
				h.steps.push(`import@${at}`);
				if (h.importFails) throw new Error("disk full");
				h.imported.push([items, attachments]);
			},
			readEntries: () => h.desktopEntries,
			deleteEmptyVault: async (id: string, _entries?: number, _files?: number) => {
				h.steps.push(`deleteEmpty:${id}@${at}`);
				return at !== id;
			},
		};
	},
}));

vi.mock("../../hooks/useVaultRegistry", () => ({
	useVaultRegistry: () => {
		const at = useActive();
		return {
			vaults: h.vaults,
			activeId: at,
			setAside: async (id: string) => {
				h.steps.push(`setAside:${id}@${at}`);
			},
		};
	},
}));

vi.mock("../../sync/enrollment", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../sync/enrollment")>()),
	decodePairingCode: () => ({ groupKey: "GROUP" }),
}));

const platform = {
	storage: { getMeta: async (k: string) => h.meta.get(k) },
	shell: { onSyncEvent: () => () => {}, syncDevicePublicKey: async () => "me" },
	files: {
		forVault: () => ({
			stage: async () => {
				h.steps.push("stage");
				if (h.failStage) throw new Error("not here");
				return {
					source: { kind: "bytes", bytes: new Uint8Array([1]) },
					name: "a.txt",
					mime: "text/plain",
					size: 1,
				};
			},
		}),
	},
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
	h.active = undefined;
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

describe("combining into the desktop's vault", () => {
	const login = (id: string, site: string) => ({
		id,
		type: "login",
		name: site,
		username: "u",
		password: "p",
		urls: [`https://${site}`],
	});

	function twoFullVaults() {
		h.vaults = [{ id: "v1", label: "Personal", createdAt: 1 }];
		h.entries = [login("a", "new.com"), login("b", "alike.com")];
		h.files = [{ id: "f1", entryId: "a", hash: "0".repeat(64) }];
		h.desktopEntries = [{ ...login("x", "alike.com"), username: "U" }];
		h.summary = { name: "Home", empty: false, entries: 1 };
		h.steps = [];
		h.imported = [];
		h.failStage = false;
	}

	it("carries before the join, copies after it, and sets the old vault aside", async () => {
		twoFullVaults();
		const result = await linkedFrom("settings");
		expect(result.current.outcome).toBe("ask");
		h.steps = [];

		await act(async () => {
			await result.current.accept("pw", { choice: "combine" });
		});

		expect(h.steps).toEqual(["stage", "join", "import@new", "setAside:v1@new"]);
		expect(h.imported[0]?.[0]).toHaveLength(1);
		expect(h.imported[0]?.[1]).toHaveLength(1);
		expect(result.current.combined?.heldBack.items).toHaveLength(1);
	});

	it("copies the held-back look-alikes when asked to", async () => {
		twoFullVaults();
		const result = await linkedFrom("settings");
		await act(async () => {
			await result.current.accept("pw", { choice: "combine" });
		});
		h.imported = [];

		await act(async () => {
			await result.current.copyHeldBack();
		});

		expect(h.imported[0]?.[0]).toHaveLength(1);
		expect(result.current.combined?.heldBack.items).toHaveLength(0);
	});

	it("says how many files it could not carry", async () => {
		twoFullVaults();
		h.failStage = true;
		const result = await linkedFrom("settings");
		await act(async () => {
			await result.current.accept("pw", { choice: "combine" });
		});
		expect(result.current.combined?.uncarried).toBe(1);
	});

	it("names the other devices still syncing this browser's vault", async () => {
		twoFullVaults();
		h.meta.set("sync.group:v1", {
			groupKey: "OTHER",
			roster: {
				devices: [
					{ publicKey: "me", label: "Chrome on Mac" },
					{ publicKey: "phone", label: "Pixel 8" },
				],
			},
		});
		const result = await linkedFrom("settings");
		expect(result.current.otherDevices).toEqual(["Pixel 8"]);
		h.meta.clear();
	});

	it("says so when the copy fails after the join, where the screen still shows it", async () => {
		twoFullVaults();
		h.importFails = true;
		const result = await linkedFrom("settings");
		await act(async () => {
			await result.current.accept("pw", { choice: "combine" });
		});
		h.importFails = false;
		expect(result.current.invite).toBeNull();
		expect(result.current.error).toMatch(/didn't copy/i);
	});

	it("keeps them separate when asked to, copying and setting aside nothing", async () => {
		twoFullVaults();
		const result = await linkedFrom("settings");
		h.steps = [];
		await act(async () => {
			await result.current.accept("pw", { choice: "separate" });
		});
		expect(h.steps).toEqual(["join"]);
	});
});

describe("an empty browser vault", () => {
	function emptyBrowserVault() {
		h.vaults = [{ id: "v1", label: "Personal", createdAt: 1 }];
		h.entries = [];
		h.files = [];
		h.meta.clear();
		h.summary = { name: "Home", empty: false, entries: 380 };
		h.steps = [];
		h.joinFails = false;
	}

	it("is removed only after the desktop's vault has arrived", async () => {
		emptyBrowserVault();
		const result = await linkedFrom("settings");
		expect(result.current.outcome).toBe("take");
		h.steps = [];
		await act(async () => {
			await result.current.accept("pw");
		});
		expect(h.steps).toEqual(["join", "deleteEmpty:v1@new"]);
	});

	it("is kept when the join fails, and the failure is shown", async () => {
		emptyBrowserVault();
		const result = await linkedFrom("settings");
		h.steps = [];
		h.joinFails = true;
		await act(async () => {
			await result.current.accept("pw");
		});
		expect(h.steps).toEqual(["join"]);
		expect(result.current.inviteError).toMatch(/join failed/i);
		h.joinFails = false;
	});
});
