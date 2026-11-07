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
	/** What each removal was told about the copy. */
	copied: [] as unknown[],
	/** Set to fail reading the old vault's bytes. */
	blobFails: false,
	setAsideFails: false,
	/** Each vault's synced settings, by vault id. */
	settings: {} as Record<string, Record<string, unknown>>,
	settingWriteFails: false,
	metaWriteFails: false,
	sealFails: false,
	/** What the old vault holds on disk, where it differs from what the window has in memory. */
	diskEntries: null as unknown[] | null,
	diskFiles: null as unknown[] | null,
	diskUnreadable: 0,
	/** Vaults whose key was dropped. */
	locked: [] as string[],
	/** Runs while an import is under way. */
	duringImport: null as (() => void) | null,
	/** Holds an import open, to look at the screen during it. */
	importHold: null as Promise<void> | null,
	/** What each removal of an empty vault was told. */
	emptyRemovals: [] as { id: string; entries?: number; files?: number; blob?: Uint8Array }[],
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
				h.duringImport?.();
				await h.importHold;
				if (h.importFails) throw new Error("disk full");
				h.imported.push([items, attachments]);
				h.importOptions.push(opts);
				return attachments.map((_, i) => `hash${i}`);
			},
			readEntries: () => h.desktopEntries,
			readOpenVaultFromDisk: async () => {
				const held = h.settings[at as string] ?? {};
				return {
					entries: h.diskEntries ?? h.entries,
					files: h.diskFiles ?? h.files,
					settings: Object.fromEntries(Object.entries(held).map(([k, value]) => [k, { value }])),
					conflicted: h.conflicts.size,
					unreadable: h.diskUnreadable,
				};
			},
			readSetting: (key: string) => h.settings[at as string]?.[key],
			writeSetting: async (key: string, value: unknown) => {
				h.steps.push(`writeSetting@${at}`);
				if (h.settingWriteFails) throw new Error("disk full");
				h.settings[at as string] = { ...h.settings[at as string], [key]: value };
			},
			deleteEmptyVault: async (id: string, entries?: number, files?: number, blob?: Uint8Array) => {
				h.emptyRemovals.push({ id, entries, files, blob });
				h.steps.push(`deleteEmpty:${id}@${at}`);
				return at !== id;
			},
			deleteCarriedVault: async (id: string, copied: unknown) => {
				h.steps.push(`deleteCarried:${id}@${at}`);
				h.copied.push(copied);
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
			hide: async (id: string) => {
				h.steps.push(`hide:${id}@${at}`);
				if (h.setAsideFails) throw new Error("storage full");
			},
			show: async (id: string) => {
				h.steps.push(`show:${id}@${at}`);
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
		setMeta: async (k: string, v: unknown) => {
			h.steps.push(`setMeta:${k}`);
			if (h.metaWriteFails) throw new Error("storage full");
			h.meta.set(k, v);
		},
		readQuarantine: async (id: string) => (h.meta.get(`quarantine:${id}`) as string) ?? null,
		readVaultBlob: async () => {
			if (h.blobFails) throw new Error("no blob");
			return new Uint8Array([7]);
		},
	},
	// Each vault's key opens only what it sealed, as a real one does.
	crypto: {
		withVault: (id: string) => ({
			lock: async () => {
				h.locked.push(id);
			},
			decryptWithVek: async (iv: string, ciphertext: string) => {
				h.steps.push(`open@${id}`);
				if (iv !== id) throw new Error("wrong key");
				return ciphertext;
			},
			encryptWithVek: async (plaintext: string) => {
				h.steps.push(`seal@${id}`);
				if (h.sealFails) throw new Error("no key");
				return { iv: id, ciphertext: plaintext };
			},
		}),
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
			h.settings = {};
			h.copied = [];
			h.diskEntries = null;
			h.diskFiles = null;
			h.diskUnreadable = 0;
			h.locked = [];
			h.duringImport = null;
			h.importHold = null;
			h.emptyRemovals = [];
		}
		const combineAs = async (opts: { choice?: "combine" | "separate" } = {}) => {
			const result = await linkedFrom("settings");
			h.steps = [];
			await act(async () => {
				await result.current.accept("pw", opts);
			});
			return result;
		};
		type Link = Awaited<ReturnType<typeof combineAs>>;
		const remove = (result: Link) =>
			act(async () => {
				await result.current.removeOldVault();
			});
		const SET_ASIDE = ["stage", "join", "import@new", "hide:v1@new"];
		const REMOVED = "deleteCarried:v1@new";

		it("is asked about and never removed unasked, hidden from the list meanwhile", async () => {
			oneFullVault();
			const result = await combineAs();
			expect(h.steps).toEqual(SET_ASIDE);
			expect(result.current.combined?.pendingRemoval?.id).toBe("v1");
			expect(result.current.combined?.keptUnasked).toBe(false);
		});

		it("goes when the user says so, and that is the end of it", async () => {
			oneFullVault();
			const result = await combineAs();
			await remove(result);
			expect(h.steps).toEqual([...SET_ASIDE, REMOVED]);
			expect(result.current.combined).toBeNull();
			expect(result.current.finishingCombine).toBe(false);
		});

		it("is listed again under its own name when the user says keep it", async () => {
			oneFullVault();
			const result = await combineAs();
			await act(async () => {
				await result.current.keepOldVault();
			});
			expect(h.steps.at(-1)).toBe("show:v1@new");
			expect(result.current.combined).toBeNull();
			await remove(result);
			expect(h.steps).not.toContain(REMOVED);
		});

		it("stays hidden, for Settings to ask again, when the dialog is closed unanswered", async () => {
			oneFullVault();
			const result = await combineAs();
			act(() => result.current.closeCombined());
			expect(result.current.combined).toBeNull();
			expect(h.steps).toEqual(SET_ASIDE);
		});

		it("has its key dropped once the copy is done, whatever the user says next", async () => {
			oneFullVault();
			await combineAs();
			expect(h.locked).toEqual(["v1"]);
		});

		it.each([
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
		])(
			"stays listed with no delete on offer, and says why, when it holds %s",
			async (_what, arrange) => {
				oneFullVault();
				arrange();
				const result = await combineAs();
				expect(h.steps).not.toContain("hide:v1@new");
				expect(result.current.combined?.pendingRemoval).toBeNull();
				expect(result.current.combined?.keptUnasked).toBe(true);
				await remove(result);
				expect(h.steps).not.toContain(REMOVED);
				h.meta.clear();
			},
		);

		it.each([
			[
				"versions in a sync conflict",
				() => {
					h.conflicts = new Map([["a", {}]]);
				},
			],
			[
				"a hint of an alias provider it no longer holds",
				() => {
					h.meta.set(aliasConfiguredHintKeyFor("v1"), true);
				},
			],
			[
				"a backup target that can't be read, which already can't back up",
				() => {
					h.meta.set(backupTargetsKeyFor("v1"), [
						{ id: "t", creds: { iv: "x", ciphertext: "{}" } },
					]);
				},
			],
		])("still has delete on offer when it holds %s", async (_what, arrange) => {
			oneFullVault();
			arrange();
			const result = await combineAs();
			expect(result.current.combined?.pendingRemoval?.id).toBe("v1");
			expect(result.current.combined?.keptUnasked).toBe(false);
			h.meta.clear();
			h.conflicts = new Map();
		});

		it("counts the entries in a sync conflict, since only the version shown comes across", async () => {
			oneFullVault();
			h.conflicts = new Map([
				["a", {}],
				["b", {}],
			]);
			const result = await combineAs();
			expect(result.current.combined?.conflicted).toBe(2);
			h.conflicts = new Map();
		});

		it("stays listed with no delete on offer when the pairing did not finish, and says so", async () => {
			oneFullVault();
			h.attaches = false;
			const result = await combineAs();
			h.attaches = true;
			expect(h.steps).not.toContain("hide:v1@new");
			expect(result.current.combined?.pendingRemoval).toBeNull();
			expect(result.current.error).toMatch(/didn't finish/i);
		});

		it("comes back to the list, and says the copy couldn't be confirmed, when the check fails", async () => {
			oneFullVault();
			h.carriedRemoved = false;
			const result = await combineAs();
			await remove(result);
			h.carriedRemoved = true;
			expect(h.steps.slice(-2)).toEqual([REMOVED, "show:v1@new"]);
			expect(result.current.combined?.pendingRemoval).toBeNull();
			expect(result.current.combined?.copyUnconfirmed).toBe(true);
			expect(result.current.combined?.keptUnasked).toBe(false);
			expect(result.current.finishingCombine).toBe(false);
		});

		it("stays listed, and is not hidden, when the copy itself fails", async () => {
			oneFullVault();
			h.importFails = true;
			await combineAs();
			h.importFails = false;
			expect(h.steps).not.toContain(REMOVED);
			expect(h.steps).not.toContain("hide:v1@new");
		});

		describe("the copy comes from the disk, not from what this window has in memory", () => {
			it("brings a login saved from another window that this one never saw", async () => {
				oneFullVault();
				h.imported = [];
				h.diskEntries = [login("a", "new.com"), login("z", "saved-elsewhere.com")];
				await combineAs();
				const names = ((h.imported[0]?.[0] ?? []) as { name: string }[]).map((e) => e.name);
				expect(names).toEqual(["new.com", "saved-elsewhere.com"]);
			});

			it("has the removal look for what was on disk too", async () => {
				oneFullVault();
				h.diskEntries = [login("a", "new.com"), login("z", "saved-elsewhere.com")];
				await remove(await combineAs());
				const { items } = h.copied[0] as { items: { name: string }[] };
				expect(items.map((e) => e.name)).toEqual(["new.com", "saved-elsewhere.com"]);
			});

			it("does not bring what memory holds and the disk no longer does", async () => {
				oneFullVault();
				h.imported = [];
				h.diskEntries = [];
				h.diskFiles = [];
				await combineAs();
				expect(h.steps).not.toContain("import@new");
			});

			it("brings a file only the disk knows of", async () => {
				oneFullVault();
				h.imported = [];
				h.files = [];
				h.diskFiles = [{ id: "f9", entryId: "a", hash: "9".repeat(64) }];
				await combineAs();
				expect(h.imported[0]?.[1]).toHaveLength(1);
			});

			it("offers no delete when the disk holds an entry that won't open", async () => {
				oneFullVault();
				h.diskUnreadable = 1;
				const result = await combineAs();
				expect(result.current.combined?.pendingRemoval).toBeNull();
				expect(result.current.combined?.keptUnasked).toBe(true);
				expect(h.steps).not.toContain("hide:v1@new");
			});

			it("decides what linking does from the disk too", async () => {
				oneFullVault();
				h.entries = [];
				h.files = [];
				h.diskEntries = [login("z", "saved-elsewhere.com")];
				h.diskFiles = [];
				const result = await linkedFrom("settings");
				expect(result.current.outcome).toBe("combine");
			});

			it("does not call a vault empty on memory's word, and it is not removed", async () => {
				oneFullVault();
				h.entries = [];
				h.files = [];
				h.summary = { name: "Home", empty: true, entries: 0 };
				// Saved elsewhere after the outcome was decided: the outcome says take.
				const result = await linkedFrom("settings");
				expect(result.current.outcome).toBe("take");
				h.diskEntries = [login("z", "saved-elsewhere.com")];
				h.diskFiles = [];
				h.steps = [];
				await act(async () => {
					await result.current.accept("pw");
				});
				expect(h.emptyRemovals).toMatchObject([{ id: "v1", entries: 1, files: 0 }]);
			});
		});

		it("says a copy is under way until the dialog can take over", async () => {
			oneFullVault();
			const result = await linkedFrom("settings");
			let release = () => {};
			h.importHold = new Promise((resolve) => {
				release = resolve;
			});
			expect(result.current.copyingOver).toBe(false);
			let accepted: Promise<boolean> | undefined;
			await act(async () => {
				accepted = result.current.accept("pw");
				await vi.waitFor(() => expect(h.steps).toContain("import@new"));
			});
			expect(result.current.copyingOver).toBe(true);
			expect(result.current.combined).toBeNull();
			await act(async () => {
				release();
				await accepted;
			});
			expect(result.current.copyingOver).toBe(false);
			expect(result.current.combined).not.toBeNull();
		});

		it("stops saying so when the copy fails", async () => {
			oneFullVault();
			h.importFails = true;
			const result = await combineAs();
			h.importFails = false;
			expect(result.current.copyingOver).toBe(false);
		});

		it("does not delete an empty vault that changed after it was read", async () => {
			oneFullVault();
			h.entries = [];
			h.files = [];
			h.summary = { name: "Home", empty: true, entries: 0 };
			const result = await linkedFrom("settings");
			await act(async () => {
				await result.current.accept("pw");
			});
			expect(h.emptyRemovals[0]?.blob).toEqual(new Uint8Array([7]));
		});

		it("tells the removal what to check, and how the old vault looked when the copy began", async () => {
			oneFullVault();
			const result = await combineAs();
			await remove(result);
			const [copied] = h.copied as {
				blob: Uint8Array;
				items: { name: string }[];
				fileHashes: string[];
			}[];
			expect(copied?.blob).toEqual(new Uint8Array([7]));
			expect(copied?.items.map((e) => e.name)).toEqual(["new.com"]);
			expect(copied?.fileHashes).toEqual(["hash0"]);
		});

		it("reads how the old vault looked before staging its files, which can take a while", async () => {
			oneFullVault();
			const order: string[] = [];
			const read = platform.storage.readVaultBlob;
			platform.storage.readVaultBlob = async () => {
				order.push(`read@${h.steps.length}`);
				return new Uint8Array([7]);
			};
			try {
				await combineAs();
			} finally {
				platform.storage.readVaultBlob = read;
			}
			// No step yet: not the staging, not the join.
			expect(order).toEqual(["read@0"]);
		});

		it("has no delete on offer when how it looked could not be read, with nothing to compare", async () => {
			oneFullVault();
			h.blobFails = true;
			try {
				const result = await combineAs();
				expect(h.steps).not.toContain("hide:v1@new");
				expect(result.current.combined?.pendingRemoval).toBeNull();
				expect(result.current.combined?.keptUnasked).toBe(true);
			} finally {
				h.blobFails = false;
			}
		});

		it("does not blame the copy when hiding the vault fails, and has nothing to ask", async () => {
			oneFullVault();
			h.setAsideFails = true;
			try {
				const result = await combineAs();
				expect(result.current.error).toBe("storage full");
				expect(result.current.combined).toBeNull();
				expect(h.steps).not.toContain(REMOVED);
			} finally {
				h.setAsideFails = false;
			}
		});

		it("touches nothing when linking opens the vault that was already open", async () => {
			oneFullVault();
			h.settings = { v1: { "pref.aliasProvider": { provider: "addy", options: {} } } };
			h.meta.set(backupTargetsKeyFor("v1"), [{ id: "t", creds: { iv: "v1", ciphertext: "{}" } }]);
			h.joinOpens = "v1";
			try {
				const result = await combineAs();
				expect(h.steps).not.toContain("hide:v1@v1");
				expect(h.steps).not.toContain("import@v1");
				expect(h.steps).not.toContain("writeSetting@v1");
				expect(h.steps).not.toContain("seal@v1");
				expect(result.current.combined).toBeNull();
			} finally {
				h.joinOpens = "new";
			}
		});

		describe("when the desktop's vault already holds its entries", () => {
			function sameOnBoth(browser: Record<string, unknown>, desktop: Record<string, unknown> = {}) {
				oneFullVault();
				h.entries = [{ ...login("a", "same.com"), ...browser }];
				h.desktopEntries = [{ ...login("x", "same.com"), ...desktop }];
				h.files = [];
				h.imported = [];
				h.importOptions = [];
				h.summary = { name: "Home", empty: false, entries: 1 };
			}
			const combineThem = () => combineAs({ choice: "combine" });

			it("brings what each copy holds besides, and the old vault can go", async () => {
				sameOnBoth({ tags: ["work"], archivedAt: undefined }, { archivedAt: 5 });
				const result = await combineThem();
				expect(h.steps).toEqual(["join", "import@new", "hide:v1@new"]);
				expect(h.imported[0]?.[0]).toEqual([]);
				expect(h.importOptions[0]).toMatchObject({
					matched: [{ id: "x", copy: { tags: ["work"] } }],
				});
				expect(result.current.combined?.pendingRemoval?.id).toBe("v1");
				expect(result.current.combined?.keptUnasked).toBe(false);
			});

			it("writes nothing when they hold the same, and the old vault can still go", async () => {
				sameOnBoth({ tags: ["work"] }, { tags: ["work"] });
				const result = await combineThem();
				expect(h.steps).toEqual(["join", "hide:v1@new"]);
				expect(result.current.combined?.pendingRemoval?.id).toBe("v1");
			});

			it("has no delete on offer when its tags will not fit on the entry", async () => {
				const tags = Array.from({ length: 32 }, (_, i) => `d${i}`);
				sameOnBoth({ tags: ["extra"] }, { tags });
				const result = await combineThem();
				expect(h.steps).toEqual(["join"]);
				expect(result.current.combined?.pendingRemoval).toBeNull();
				expect(result.current.combined?.keptUnasked).toBe(true);
			});
		});

		describe("when it holds look-alikes of the desktop's entries", () => {
			function withLookAlike() {
				oneFullVault();
				h.entries = [login("a", "new.com"), login("b", "alike.com")];
				h.files = [
					{ id: "f1", entryId: "a", hash: "0".repeat(64) },
					{ id: "f2", entryId: "b", hash: "1".repeat(64) },
				];
				h.desktopEntries = [{ ...login("x", "alike.com"), username: "U" }];
				h.summary = { name: "Home", empty: false, entries: 1 };
				h.imported = [];
			}
			const combine = () => combineAs({ choice: "combine" });
			const copy = (result: Link) =>
				act(async () => {
					await result.current.copyHeldBack();
				});
			const namesToCheck = () =>
				(h.copied[0] as { items: { name: string }[] }).items.map((e) => e.name);

			it("holds them back and leaves the deleting to the user", async () => {
				withLookAlike();
				const result = await combine();
				expect(h.steps).not.toContain(REMOVED);
				expect(result.current.combined?.heldBack.items).toHaveLength(1);
				expect(result.current.combined?.pendingRemoval?.id).toBe("v1");
				expect(result.current.combined?.keptUnasked).toBe(false);
			});

			it("copying them removes nothing, and the question stays open", async () => {
				withLookAlike();
				const result = await combine();
				h.steps = [];
				await copy(result);
				expect(h.steps).toEqual(["import@new"]);
				expect(result.current.combined?.heldBack.items).toHaveLength(0);
				expect(result.current.combined?.pendingRemoval?.id).toBe("v1");
			});

			it("deleting after copying has the removal check for them and their files too", async () => {
				withLookAlike();
				const result = await combine();
				await copy(result);
				await remove(result);
				expect(namesToCheck()).toEqual(["new.com", "alike.com"]);
				expect((h.copied[0] as { fileHashes: string[] }).fileHashes).toEqual(["hash0", "hash0"]);
				expect(result.current.combined).toBeNull();
			});

			it("deleting without copying leaves them out, the removal not looking for them", async () => {
				withLookAlike();
				const result = await combine();
				h.steps = [];
				await remove(result);
				expect(h.steps).toEqual([REMOVED]);
				expect(namesToCheck()).toEqual(["new.com"]);
				expect(result.current.combined).toBeNull();
			});

			it("removes nothing when copying them fails, and offers it again", async () => {
				withLookAlike();
				const result = await combine();
				h.steps = [];
				h.importFails = true;
				await copy(result);
				h.importFails = false;
				expect(h.steps).toEqual(["import@new"]);
				expect(result.current.error).toMatch(/didn't copy/i);
				expect(result.current.combined?.heldBack.items).toHaveLength(1);
				expect(result.current.combined?.pendingRemoval?.id).toBe("v1");
				expect(result.current.finishingCombine).toBe(false);
			});

			it("still copies them when something else keeps the vault, with no delete on offer", async () => {
				withLookAlike();
				h.failStage = true;
				const result = await combine();
				expect(result.current.combined?.pendingRemoval).toBeNull();
				expect(result.current.combined?.keptUnasked).toBe(true);
				h.failStage = false;
				h.steps = [];
				await copy(result);
				expect(h.steps).toEqual(["import@new"]);
				expect(result.current.combined?.keptUnasked).toBe(true);
			});
		});

		describe("what it brings besides entries and files", () => {
			const ALIAS = "pref.aliasProvider";
			const mine = { provider: "addy", options: { domain: "mine.example" }, apiKey: "my-key" };
			const theirs = { provider: "simplelogin", options: {}, apiKey: "their-key" };
			const liveTarget = (extra: Record<string, unknown> = {}) => ({
				id: "t1",
				providerId: "nextcloud",
				provider: "webdav",
				serverUrl: "https://dav.example/",
				path: "/mine",
				frequency: "daily",
				keep: 7,
				creds: { iv: "v1", ciphertext: '{"password":"s3"}' },
				lastBackupAt: 5,
				lastVaultHash: "abc",
				...extra,
			});
			const targetsOf = (id: string) =>
				h.meta.get(backupTargetsKeyFor(id)) as
					| { creds: unknown; path: string; lastBackupAt?: number }[]
					| undefined;
			const withTarget = () => h.meta.set(backupTargetsKeyFor("v1"), [liveTarget()]);
			const proof = () => h.copied[0] as { settings?: string[] };

			describe("the alias provider", () => {
				it("comes across when the desktop's vault has none, in the vault that opened", async () => {
					oneFullVault();
					h.settings = { v1: { [ALIAS]: mine } };
					const result = await combineAs();
					expect(h.settings.new?.[ALIAS]).toEqual(mine);
					expect(h.steps).toEqual([
						"stage",
						"join",
						"import@new",
						"writeSetting@new",
						"hide:v1@new",
					]);
					expect(result.current.combined?.leftBehind.alias).toBe(false);
					expect(result.current.combined?.keptUnasked).toBe(false);
				});

				it("has the removal check it reached the disk", async () => {
					oneFullVault();
					h.settings = { v1: { [ALIAS]: mine } };
					await remove(await combineAs());
					expect(proof().settings).toEqual([ALIAS]);
				});

				it("comes across over one the desktop's vault turned off", async () => {
					oneFullVault();
					h.settings = { v1: { [ALIAS]: mine }, new: { [ALIAS]: null } };
					await combineAs();
					expect(h.settings.new?.[ALIAS]).toEqual(mine);
				});

				it("writes nothing when the browser's vault has none", async () => {
					oneFullVault();
					const result = await combineAs();
					expect(h.steps).not.toContain("writeSetting@new");
					expect(result.current.combined?.leftBehind.alias).toBe(false);
					await remove(result);
					expect(proof().settings).toEqual([]);
				});

				it("brings a provider this build doesn't know, as it is, for a build that does", async () => {
					oneFullVault();
					const newer = { provider: "from-a-newer-build", apiKey: "k" };
					h.settings = { v1: { [ALIAS]: newer } };
					await combineAs();
					expect(h.settings.new?.[ALIAS]).toEqual(newer);
				});

				it("never overwrites a desktop provider this build doesn't know", async () => {
					oneFullVault();
					const newer = { provider: "from-a-newer-build", apiKey: "their-key" };
					h.settings = { v1: { [ALIAS]: mine }, new: { [ALIAS]: newer } };
					const result = await combineAs();
					expect(h.settings.new?.[ALIAS]).toEqual(newer);
					expect(h.steps).not.toContain("writeSetting@new");
					expect(result.current.combined?.leftBehind.alias).toBe(true);
				});

				it("has nothing to say when both hold the same one", async () => {
					oneFullVault();
					h.settings = { v1: { [ALIAS]: mine }, new: { [ALIAS]: { ...mine } } };
					const result = await combineAs();
					expect(h.steps).not.toContain("writeSetting@new");
					expect(result.current.combined?.leftBehind.alias).toBe(false);
				});

				it("gives way to the desktop's own, and says so, with delete still on offer", async () => {
					oneFullVault();
					h.settings = { v1: { [ALIAS]: mine }, new: { [ALIAS]: theirs } };
					const result = await combineAs();
					expect(h.settings.new?.[ALIAS]).toEqual(theirs);
					expect(h.steps).not.toContain("writeSetting@new");
					expect(result.current.combined?.leftBehind.alias).toBe(true);
					expect(result.current.combined?.pendingRemoval?.id).toBe("v1");
				});

				it("takes delete off the offer, and says why, when writing it fails", async () => {
					oneFullVault();
					h.settings = { v1: { [ALIAS]: mine } };
					h.settingWriteFails = true;
					const result = await combineAs();
					h.settingWriteFails = false;
					expect(h.steps).not.toContain("hide:v1@new");
					expect(result.current.combined?.pendingRemoval).toBeNull();
					expect(result.current.combined?.keptUnasked).toBe(true);
					expect(result.current.error).toBeNull();
				});
			});

			describe("backup targets", () => {
				it("come across when the desktop has none, sealed under the desktop vault's key", async () => {
					oneFullVault();
					h.summary = { name: "Home", empty: true, entries: 0, backupTargets: false };
					withTarget();
					const result = await combineAs();
					const [moved] = targetsOf("new") ?? [];
					expect(moved?.creds).toEqual({ iv: "new", ciphertext: '{"password":"s3"}' });
					expect(moved?.path).toBe("/mine");
					expect(moved?.lastBackupAt).toBeUndefined();
					expect(result.current.combined?.leftBehind.backupTargets).toBe(false);
				});

				it("open with the old key before the join, and seal with the new one after it", async () => {
					oneFullVault();
					withTarget();
					await combineAs();
					const at = (step: string) => h.steps.indexOf(step);
					expect(at("open@v1")).toBeGreaterThanOrEqual(0);
					expect(at("open@v1")).toBeLessThan(at("join"));
					expect(at("seal@new")).toBeGreaterThan(at("join"));
					expect(h.steps).not.toContain("open@new");
					expect(h.steps).not.toContain("seal@v1");
				});

				it.each([
					["an older app, which does not say", { name: "Home", empty: true, entries: 0 }],
					["an app that will not say at all", null],
				])(
					"come across for %s: losing them is worse than two destinations",
					async (_what, summary) => {
						oneFullVault();
						h.summary = summary;
						withTarget();
						await combineAs({ choice: "combine" });
						expect(targetsOf("new")).toHaveLength(1);
					},
				);

				it("give way when the desktop has one, and say so, with delete still on offer", async () => {
					oneFullVault();
					h.summary = { name: "Home", empty: true, entries: 0, backupTargets: true };
					withTarget();
					const result = await combineAs();
					expect(targetsOf("new")).toBeUndefined();
					expect(h.steps).not.toContain("seal@new");
					expect(result.current.combined?.leftBehind.backupTargets).toBe(true);
					expect(result.current.combined?.pendingRemoval?.id).toBe("v1");
				});

				it("never overwrite what the vault that opened already has on this browser", async () => {
					oneFullVault();
					withTarget();
					const own = [{ id: "own", creds: { iv: "new", ciphertext: "{}" } }];
					h.meta.set(backupTargetsKeyFor("new"), own);
					const result = await combineAs();
					expect(h.meta.get(backupTargetsKeyFor("new"))).toEqual(own);
					expect(result.current.combined?.leftBehind.backupTargets).toBe(true);
				});

				it("say how many couldn't be read, without holding up the delete", async () => {
					oneFullVault();
					h.summary = { name: "Home", empty: true, entries: 0, backupTargets: true };
					h.meta.set(backupTargetsKeyFor("v1"), [
						liveTarget({ id: "a", creds: { iv: "other", ciphertext: "{}" } }),
						liveTarget({ id: "b", creds: { iv: "another", ciphertext: "{}" } }),
					]);
					const result = await combineAs();
					expect(targetsOf("new")).toBeUndefined();
					expect(result.current.combined?.leftBehind.backupTargets).toBe(false);
					expect(result.current.combined?.leftBehind.unreadableTargets).toBe(2);
					expect(result.current.combined?.pendingRemoval?.id).toBe("v1");
				});

				it("still bring the ones that open alongside one that won't", async () => {
					oneFullVault();
					h.meta.set(backupTargetsKeyFor("v1"), [
						liveTarget({ id: "a", creds: { iv: "other", ciphertext: "{}" } }),
						liveTarget({ id: "b" }),
					]);
					const result = await combineAs();
					expect(targetsOf("new")).toHaveLength(1);
					expect(result.current.combined?.leftBehind.unreadableTargets).toBe(1);
				});

				it.each([
					["storing them", "metaWriteFails"],
					["sealing them", "sealFails"],
				] as const)(
					"take delete off the offer, and say why, when %s fails",
					async (_what, flag) => {
						oneFullVault();
						withTarget();
						h[flag] = true;
						const result = await combineAs();
						h[flag] = false;
						expect(result.current.combined?.pendingRemoval).toBeNull();
						expect(result.current.combined?.keptUnasked).toBe(true);
					},
				);
			});

			it("leave the old vault as it was", async () => {
				oneFullVault();
				h.settings = { v1: { [ALIAS]: mine } };
				withTarget();
				await combineAs();
				expect(h.settings.new?.[ALIAS]).toEqual(mine);
				expect(targetsOf("new")).toHaveLength(1);
				expect(h.settings.v1?.[ALIAS]).toEqual(mine);
				expect(targetsOf("v1")?.[0]?.lastBackupAt).toBe(5);
			});

			it("touch nothing when the vaults stay separate", async () => {
				oneFullVault();
				h.summary = { name: "Home", empty: false, entries: 1 };
				h.settings = { v1: { [ALIAS]: mine } };
				withTarget();
				await combineAs({ choice: "separate" });
				expect(h.steps).not.toContain("writeSetting@new");
				expect(h.steps).not.toContain("open@v1");
				expect(targetsOf("new")).toBeUndefined();
			});

			it("take delete off the offer when another vault opened during the import", async () => {
				oneFullVault();
				h.settings = { v1: { [ALIAS]: mine } };
				withTarget();
				h.duringImport = () => switchTo("other");
				try {
					const result = await combineAs();
					expect(h.settings.other).toBeUndefined();
					expect(targetsOf("other")).toBeUndefined();
					expect(result.current.combined?.pendingRemoval).toBeNull();
					expect(result.current.combined?.keptUnasked).toBe(true);
				} finally {
					h.duringImport = null;
					h.active = undefined;
				}
			});

			it("take delete off the offer when another vault opened before they could land", async () => {
				oneFullVault();
				h.settings = { v1: { [ALIAS]: mine } };
				withTarget();
				h.afterJoin = "other";
				try {
					const result = await combineAs();
					expect(h.settings.other).toBeUndefined();
					expect(targetsOf("other")).toBeUndefined();
					expect(targetsOf("new")).toBeUndefined();
					expect(result.current.combined?.pendingRemoval).toBeNull();
					expect(result.current.combined?.keptUnasked).toBe(true);
				} finally {
					h.afterJoin = null;
				}
			});

			it("one failing still brings the other", async () => {
				oneFullVault();
				h.settings = { v1: { [ALIAS]: mine } };
				withTarget();
				h.settingWriteFails = true;
				const result = await combineAs();
				h.settingWriteFails = false;
				expect(targetsOf("new")).toHaveLength(1);
				expect(result.current.combined?.keptUnasked).toBe(true);
			});

			it("are still left to the desktop's when delete is off the offer for another reason", async () => {
				oneFullVault();
				h.settings = { v1: { [ALIAS]: mine }, new: { [ALIAS]: theirs } };
				h.failStage = true;
				const result = await combineAs();
				expect(result.current.combined?.leftBehind.alias).toBe(true);
				expect(result.current.combined?.pendingRemoval).toBeNull();
				expect(result.current.combined?.keptUnasked).toBe(true);
			});
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

		expect(h.steps).toEqual(["stage", "join", "import@new", "hide:v1@new"]);
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

			expect(h.steps).toEqual(["stage", "join", "import@new"]);
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

			expect(h.steps).toEqual(["stage", "join", "import@new"]);
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
		expect(h.importOptions).toMatchObject([{ ownVault: true }, { ownVault: true }]);
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
