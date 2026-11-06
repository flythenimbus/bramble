/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act, renderHook } from "@testing-library/react";
import { type ReactNode, useSyncExternalStore } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { aliasConfiguredHintKeyFor } from "../../aliases/config";
import { backupTargetsKeyFor } from "../../backup/config";
import { type Platform, PlatformProvider } from "../../context/PlatformContext";
import { syncKeyFor } from "../../sync/sync-keys";
import { useDesktopLink } from "./useDesktopLink";

// The one link flow behind both the setup banner and Settings: emoji, then what the desktop vault
// holds, then its invite, then what joining does to this browser.

const h = vi.hoisted(() => ({
	calls: [] as string[],
	joins: [] as unknown[][],
	vaults: [] as { id: string; label: string; createdAt: number }[],
	summary: { name: "Home", empty: false, entries: 380 } as unknown,
	/** Resolves when the desktop app answers the link; held open to see the wait in between. */
	confirmHold: Promise.resolve() as Promise<void>,
	/** What claiming the desktop's invite returns; null when it hands over none. */
	invite: "invite" as string | null,
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
	syncEvent: null as ((e: { kind: string; sas?: string; sasEmoji?: number[] }) => void) | null,
	/** The open vault, as the provider sees it. Unset means the first vault in `vaults`. */
	active: undefined as string | undefined,
	subs: new Set<() => void>(),
	/** The vault a join opens: a new one, or one this browser already has. */
	joinOpens: "new",
	/** Set to open another vault right after the join, as the user might elsewhere. */
	afterJoin: null as string | null,
	/** Whether the app lists the link once the vault is in. */
	attaches: true,
	/** Set to make attaching fail outright, as a dead pipe to the background would. */
	attachThrows: false,
	/** The open vault's sync conflicts. */
	conflicts: new Map<string, unknown>(),
	/** What removing a vault whose entries were copied out answers. */
	carriedRemoved: true,
	/** The options each import was made with. */
	importOptions: [] as unknown[],
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
	useVault: () => ({ entries: h.entries, files: h.files, conflicts: h.conflicts }),
	// Like the real provider, each action is bound to the vault open when it was made.
	useVaultActions: () => {
		const at = useActive();
		return {
			startJoin: async (...args: unknown[]) => {
				h.steps.push("join");
				h.joins.push(args);
				if (h.joinFails) throw new Error("join failed");
				switchTo(h.joinOpens);
				if (h.afterJoin) switchTo(h.afterJoin);
				return h.joinOpens;
			},
			importEntries: async (items: unknown[], attachments: unknown[] = [], opts?: unknown) => {
				h.steps.push(`import@${at}`);
				if (h.importFails) throw new Error("disk full");
				h.imported.push([items, attachments]);
				h.importOptions.push(opts);
			},
			readEntries: () => h.desktopEntries,
			deleteEmptyVault: async (id: string, _entries?: number, _files?: number) => {
				h.steps.push(`deleteEmpty:${id}@${at}`);
				return at !== id;
			},
			deleteCarriedVault: async (id: string) => {
				h.steps.push(`deleteCarried:${id}@${at}`);
				return h.carriedRemoved;
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
	storage: {
		getMeta: async (k: string) => h.meta.get(k),
		readQuarantine: async (id: string) => (h.meta.get(`quarantine:${id}`) as string) ?? null,
	},
	shell: {
		onSyncEvent: (cb: (e: { kind: string; sas?: string; sasEmoji?: number[] }) => void) => {
			h.syncEvent = cb;
			return () => {};
		},
		syncDevicePublicKey: async () => "me",
	},
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
			await h.confirmHold;
		},
		cancel: async (id: string) => {
			h.calls.push(`cancel:${id}`);
		},
		vaultSummary: async () => {
			h.calls.push("summary");
			return h.summary;
		},
		pair: async () => {
			h.calls.push("pair");
		},
		claimSyncInvite: async () => {
			h.calls.push("claim");
			return h.invite;
		},
		attach: async (vaultId: string) => {
			h.calls.push(`attach:${vaultId}`);
			if (h.attachThrows) throw new Error("no answer");
			return h.attaches;
		},
		abandon: async () => {
			h.calls.push("abandon");
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

		let done: boolean | undefined;
		await act(async () => {
			done = await result.current.accept("pw");
		});
		// The setup screen moves on only on this, so a join that worked must say so.
		expect(done).toBe(true);
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

	it("says it is waiting for the desktop app once they match, until the app answers", async () => {
		// The link completes when both screens have said yes, whichever is last. Without this the
		// browser looked as though "They match" had done nothing.
		h.vaults = [];
		let release = () => {};
		h.confirmHold = new Promise<void>((resolve) => {
			release = resolve;
		});
		try {
			const { result } = renderHook(() => useDesktopLink({ from: "setup" }), { wrapper });
			await act(async () => {
				await result.current.start();
			});
			let answering: Promise<void> = Promise.resolve();
			act(() => {
				answering = result.current.answer(true);
			});
			expect(result.current.awaitingApp).toBe(true);
			await act(async () => {
				release();
				await answering;
			});
			expect(result.current.awaitingApp).toBe(false);
		} finally {
			h.confirmHold = Promise.resolve();
		}
	});

	it("says so when the desktop sends no vault after an emoji link", async () => {
		// An app that links by emoji always arms one. Without this the screen went back to its
		// first step with nothing said, as if the link had never happened.
		h.vaults = [];
		h.invite = null;
		try {
			const result = await linkedFrom("setup");
			expect(result.current.invite).toBeNull();
			expect(result.current.error).toBeTruthy();
		} finally {
			h.invite = "invite";
		}
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

	describe("the old vault afterwards", () => {
		/** A browser vault with one login and a file, all of which fits in the desktop's. */
		function oneFullVault() {
			twoFullVaults();
			h.entries = [login("a", "new.com")];
			h.desktopEntries = [];
			h.summary = { name: "Home", empty: true, entries: 0 };
			h.conflicts = new Map();
			h.carriedRemoved = true;
			h.failStage = false;
			h.meta.clear();
			h.attaches = true;
		}
		const combineAs = async (opts: { keepCopy?: boolean } = {}) => {
			const result = await linkedFrom("settings");
			h.steps = [];
			await act(async () => {
				await result.current.accept("pw", opts);
			});
			return result;
		};
		const SET_ASIDE = ["stage", "join", "import@new", "setAside:v1@new"];

		it("goes, once all of it is in the desktop's, with nothing asked", async () => {
			oneFullVault();
			const result = await combineAs();
			expect(h.steps).toEqual(["stage", "join", "import@new", "deleteCarried:v1@new"]);
			expect(result.current.combined?.keptUnasked).toBe(false);
		});

		it("stays when asked to keep a copy", async () => {
			oneFullVault();
			const result = await combineAs({ keepCopy: true });
			expect(h.steps).toEqual(SET_ASIDE);
			expect(result.current.combined?.keptUnasked).toBe(false);
		});

		it.each([
			[
				"look-alikes held back for review",
				() => {
					h.desktopEntries = [{ ...login("x", "new.com"), username: "U" }];
				},
			],
			[
				"a file that did not copy",
				() => {
					h.failStage = true;
				},
			],
			[
				"entries it could not decrypt",
				() => {
					h.meta.set("quarantine:v1", JSON.stringify([{ id: "q" }]));
				},
			],
			[
				"versions in a sync conflict",
				() => {
					h.conflicts = new Map([["a", {}]]);
				},
			],
			[
				"an email alias provider and its key",
				() => {
					h.meta.set(aliasConfiguredHintKeyFor("v1"), true);
				},
			],
			[
				"backup targets",
				() => {
					h.meta.set(backupTargetsKeyFor("v1"), [{ id: "t" }]);
				},
			],
		])("stays, and says so, when it holds %s, which do not come across", async (_what, arrange) => {
			oneFullVault();
			arrange();
			const result = await combineAs();
			expect(h.steps.at(-1)).toBe("setAside:v1@new");
			expect(h.steps).not.toContain("deleteCarried:v1@new");
			expect(result.current.combined?.keptUnasked).toBe(true);
			h.meta.clear();
			h.conflicts = new Map();
		});

		it("stays when the pairing did not finish", async () => {
			oneFullVault();
			h.attaches = false;
			const result = await combineAs();
			expect(h.steps).toEqual(SET_ASIDE);
			expect(result.current.error).toMatch(/didn't finish/i);
			h.attaches = true;
		});

		it("stays when the copy is not on disk to read back", async () => {
			oneFullVault();
			h.carriedRemoved = false;
			const result = await combineAs();
			expect(h.steps.at(-1)).toBe("setAside:v1@new");
			expect(result.current.combined?.keptUnasked).toBe(true);
			h.carriedRemoved = true;
		});

		it("stays when the copy itself fails", async () => {
			oneFullVault();
			h.importFails = true;
			await combineAs();
			h.importFails = false;
			expect(h.steps).not.toContain("deleteCarried:v1@new");
		});
	});

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

	it("still combines when the app will not finish the pairing, then says so", async () => {
		// The vault is already here; what the user chose for theirs happens either way.
		twoFullVaults();
		h.attaches = false;
		try {
			const result = await linkedFrom("settings");
			h.steps = [];
			let done: boolean | undefined;
			await act(async () => {
				done = await result.current.accept("pw", { choice: "combine" });
			});

			expect(h.steps).toEqual(["stage", "join", "import@new", "setAside:v1@new"]);
			expect(done).toBe(false);
			expect(result.current.error).toMatch(/didn't finish/i);
		} finally {
			h.attaches = true;
		}
	});

	it("still combines when attaching the link fails outright, then says so", async () => {
		twoFullVaults();
		h.attachThrows = true;
		try {
			const result = await linkedFrom("settings");
			h.steps = [];
			let done: boolean | undefined;
			await act(async () => {
				done = await result.current.accept("pw", { choice: "combine" });
			});

			expect(h.steps).toEqual(["stage", "join", "import@new", "setAside:v1@new"]);
			expect(done).toBe(false);
			expect(result.current.error).toMatch(/didn't finish/i);
		} finally {
			h.attachThrows = false;
		}
	});

	it("copies as the user's own vault, so old passwords come too, whichever way they arrive", async () => {
		twoFullVaults();
		h.importOptions = [];
		const result = await linkedFrom("settings");
		await act(async () => {
			await result.current.accept("pw", { choice: "combine" });
		});
		await act(async () => {
			await result.current.copyHeldBack();
		});
		expect(h.importOptions).toEqual([{ ownVault: true }, { ownVault: true }]);
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

	it("says how many damaged entries stayed behind in the old vault", async () => {
		twoFullVaults();
		h.meta.set("quarantine:v1", JSON.stringify([{ id: "q1" }, { id: "q2" }]));
		const result = await linkedFrom("settings");
		await act(async () => {
			await result.current.accept("pw", { choice: "combine" });
		});
		h.meta.clear();
		expect(result.current.combined?.quarantined).toBe(2);
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
		let done: boolean | undefined;
		await act(async () => {
			done = await result.current.accept("pw");
		});
		expect(done).toBe(false);
		expect(h.steps).toEqual(["join"]);
		expect(result.current.inviteError).toMatch(/join failed/i);
		h.joinFails = false;
	});
});

describe("an older desktop app, linked with the code", () => {
	async function linkedByCode() {
		h.vaults = [];
		h.start = { legacy: true };
		h.summary = null;
		h.joins = [];
		const { result } = renderHook(() => useDesktopLink({ from: "setup" }), { wrapper });
		await act(async () => {
			await result.current.start();
		});
		act(() => result.current.setCode("ABCD2345"));
		await act(async () => {
			await result.current.pairWithCode();
		});
		h.start = { id: "L1", sas: { emoji: [0, 1, 2, 3, 4, 5, 6], digits: "1" } };
		return result;
	}

	it("joins over the relay, which is all an older app can serve", async () => {
		const result = await linkedByCode();
		await act(async () => {
			await result.current.accept("pw");
		});
		expect(h.joins[0]?.[3]).toEqual({ viaLink: false });
	});

	it("offers Try again when it sends no vault, as an emoji link does", async () => {
		// A link with no vault in the browser is half a pairing, however it was made.
		h.invite = null;
		try {
			const result = await linkedByCode();
			expect(result.current.claimFailed).toBe(true);
			expect(result.current.error).toBeTruthy();
		} finally {
			h.invite = "invite";
		}
	});

	it("shows the emoji the older app asks to compare during the copy", async () => {
		const result = await linkedByCode();
		act(() =>
			h.syncEvent?.({ kind: "sas", sas: "1234 5678 9012", sasEmoji: [1, 2, 3, 4, 5, 6, 7] }),
		);
		expect(result.current.joinSas?.digits).toBe("1234 5678 9012");
		act(() => h.syncEvent?.({ kind: "joined" }));
		expect(result.current.joinSas).toBeNull();
	});
});

describe("a pairing, start to end", () => {
	// A link belongs to the browser vault that ends up holding the desktop's, and is never half made.
	const reset = () => {
		h.vaults = [];
		h.calls = [];
		h.joinOpens = "new";
		h.afterJoin = null;
		h.attaches = true;
		h.invite = "invite";
	};

	it("attaches the link to the vault the join opened", async () => {
		reset();
		const result = await linkedFrom("setup");
		await act(async () => {
			await result.current.accept("pw");
		});
		expect(h.calls).toContain("attach:new");
	});

	it("attaches it to the vault the browser already had, when the join opens that one", async () => {
		reset();
		h.vaults = [{ id: "v1", label: "", createdAt: 1 }];
		h.joinOpens = "v2";
		const result = await linkedFrom("settings");
		await act(async () => {
			await result.current.accept("pw", { choice: "separate" });
		});
		expect(h.calls).toContain("attach:v2");
	});

	it("links again from the vault that already syncs with the desktop, with no false error", async () => {
		// Disconnect, then Link, in that vault: the join opens the vault already open.
		reset();
		h.vaults = [{ id: "v1", label: "", createdAt: 1 }];
		h.meta.set(syncKeyFor("sync.group", "v1"), { groupKey: "GROUP" });
		h.joinOpens = "v1";
		try {
			const result = await linkedFrom("settings");
			expect(result.current.outcome).toBe("switch");
			expect(result.current.sharedIsOpen).toBe(true);
			let done: boolean | undefined;
			await act(async () => {
				done = await result.current.accept("pw");
			});

			expect(done).toBe(true);
			expect(result.current.error).toBeNull();
			expect(h.calls).toContain("attach:v1");
		} finally {
			h.meta.delete(syncKeyFor("sync.group", "v1"));
		}
	});

	it("says which vault it opens when another one already syncs with the desktop", async () => {
		reset();
		h.vaults = [
			{ id: "v1", label: "", createdAt: 1 },
			{ id: "v2", label: "", createdAt: 2 },
		];
		h.meta.set(syncKeyFor("sync.group", "v2"), { groupKey: "GROUP" });
		try {
			const result = await linkedFrom("settings");
			expect(result.current.outcome).toBe("switch");
			expect(result.current.sharedIsOpen).toBe(false);
		} finally {
			h.meta.delete(syncKeyFor("sync.group", "v2"));
		}
	});

	it("attaches it to the vault the join opened, not one opened elsewhere since", async () => {
		reset();
		h.afterJoin = "other";
		const result = await linkedFrom("setup");
		await act(async () => {
			await result.current.accept("pw");
		});
		expect(h.calls).toContain("attach:new");
		expect(h.calls).not.toContain("attach:other");
	});

	it("has Settings look again once the link is attached, not only once it is made", async () => {
		// A link in progress is not linked yet, so the status read after the emoji says so.
		reset();
		h.active = undefined;
		const { result } = renderHook(
			() =>
				useDesktopLink({
					from: "settings",
					onLinked: () => {
						h.calls.push("refresh");
					},
				}),
			{ wrapper },
		);
		await act(async () => {
			await result.current.start();
		});
		await act(async () => {
			await result.current.answer(true);
		});
		await act(async () => {
			await result.current.accept("pw");
		});

		expect(h.calls.lastIndexOf("refresh")).toBeGreaterThan(h.calls.indexOf("attach:new"));
	});

	it("says so when the app will not finish the pairing", async () => {
		reset();
		h.attaches = false;
		const result = await linkedFrom("setup");
		let done: boolean | undefined;
		await act(async () => {
			done = await result.current.accept("pw");
		});
		expect(done).toBe(false);
		expect(result.current.error).toMatch(/didn't finish/i);
	});

	it("claims again on Try again, after the desktop sent no vault", async () => {
		reset();
		h.invite = null;
		const result = await linkedFrom("setup");
		expect(result.current.claimFailed).toBe(true);

		h.invite = "invite";
		await act(async () => {
			await result.current.retryClaim();
		});
		expect(result.current.invite).toBe("invite");
		expect(result.current.claimFailed).toBe(false);
		expect(result.current.error).toBeNull();
	});

	it("lets go of a link it made when the screen goes away before the vault is in", async () => {
		reset();
		const { result, unmount } = renderHook(() => useDesktopLink({ from: "setup" }), { wrapper });
		await act(async () => {
			await result.current.start();
		});
		await act(async () => {
			await result.current.answer(true);
		});
		unmount();
		expect(h.calls).toContain("abandon");
	});

	it("keeps the link when the screen goes away after it attached", async () => {
		reset();
		const { result, unmount } = renderHook(() => useDesktopLink({ from: "setup" }), { wrapper });
		await act(async () => {
			await result.current.start();
		});
		await act(async () => {
			await result.current.answer(true);
		});
		await act(async () => {
			await result.current.accept("pw");
		});
		unmount();
		expect(h.calls).not.toContain("abandon");
	});

	it("abandons the link when the vault's offer is closed", async () => {
		reset();
		const result = await linkedFrom("setup");
		await act(async () => {
			await result.current.abandon();
		});
		expect(h.calls).toContain("abandon");
		expect(result.current.invite).toBeNull();
	});
});

describe("walking away", () => {
	it("lets go of a link nobody answered when the screen goes away", async () => {
		h.vaults = [];
		h.calls = [];
		const { result, unmount } = renderHook(() => useDesktopLink({ from: "setup" }), { wrapper });
		await act(async () => {
			await result.current.start();
		});
		unmount();
		expect(h.calls).toContain("cancel:L1");
	});
});
