// One link flow for the setup banner and Settings: compare emoji, learn what the desktop vault
// holds, claim its invite, then join over the link. See docs/desktop-link-onboarding.md.

import { useLingui } from "@lingui/react/macro";
import { useCallback, useEffect, useRef, useState } from "react";
import { isAliasConfig, sameAliasConfig } from "../../aliases/config";
import { type BackupTargetConfig, backupTargetsKeyFor } from "../../backup/config";
import { type Platform, usePlatform } from "../../context/PlatformContext";
import { PREF_ALIAS_PROVIDER } from "../../hooks/usePrefs";
import { type EntryData, useVault, useVaultActions } from "../../hooks/useVault";
import { useVaultRegistry } from "../../hooks/useVaultRegistry";
import type { PlacedAttachment } from "../../import/types";
import { decodePairingCode } from "../../sync/enrollment";
import {
	type LinkFrom,
	type LinkOutcome,
	type LinkSide,
	linkOutcome,
} from "../../sync/link-outcome";
import type { PairingSas } from "../../sync/pairing-sas";
import { syncKeyFor } from "../../sync/sync-keys";
import {
	type CarriedTarget,
	type CopiedOut,
	collectCarry,
	placeCarry,
	readCarriedTargets,
	sealCarriedTargets,
	withoutHeldBack,
} from "../../vault/combine-into";
import { holdsQuarantine, isVaultEmpty, readVaultContents } from "../../vault/vault-empty";

/** What came across besides entries and files, and what stayed behind the desktop's own. */
interface BroughtSettings {
	/** The synced settings written, for the removal to find on disk. */
	settings: string[];
	leftBehind: { alias: boolean; backupTargets: boolean };
	failed: boolean;
}

/**
 * Bring the old vault's alias provider and backup targets into the vault that opened, each only
 * where that vault has none of its own. A failure leaves the old vault in place: see `accept`.
 */
async function bringSettings(from: {
	alias: unknown;
	targets: readonly CarriedTarget[];
	/** Targets never sync, so only the app can say. One that won't counts as having none: losing
	 * the browser's targets is worse than a second destination. */
	desktopHasTargets: boolean;
	opened: string;
	actions: Pick<ReturnType<typeof useVaultActions>, "readSetting" | "writeSetting">;
	storage: Pick<Platform["storage"], "getMeta" | "setMeta">;
	crypto: Platform["crypto"];
}): Promise<BroughtSettings> {
	const { alias, targets, desktopHasTargets, opened, actions, storage, crypto } = from;
	const brought: BroughtSettings = {
		settings: [],
		leftBehind: { alias: false, backupTargets: false },
		failed: false,
	};
	// Apart, so one failing still brings the other.
	try {
		if (isAliasConfig(alias)) {
			const own = actions.readSetting(PREF_ALIAS_PROVIDER);
			if (!isAliasConfig(own)) {
				await actions.writeSetting(PREF_ALIAS_PROVIDER, alias);
				brought.settings.push(PREF_ALIAS_PROVIDER);
			} else if (!sameAliasConfig(alias, own)) {
				brought.leftBehind.alias = true;
			}
		}
	} catch {
		brought.failed = true;
	}
	try {
		if (targets.length > 0) {
			const key = backupTargetsKeyFor(opened);
			if (desktopHasTargets || (await storage.getMeta<unknown[]>(key))?.length) {
				brought.leftBehind.backupTargets = true;
			} else {
				await storage.setMeta(
					key,
					await sealCarriedTargets(targets, crypto.withVault?.(opened) ?? crypto),
				);
			}
		}
	} catch {
		brought.failed = true;
	}
	return brought;
}

/** How many quarantine records a vault holds (see vault/quarantine.ts). */
async function countQuarantined(
	storage: { readQuarantine?(vaultId?: string): Promise<string | null> },
	vaultId: string,
): Promise<number> {
	const raw = await storage.readQuarantine?.(vaultId).catch(() => null);
	if (!raw) return 0;
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.length : 1;
	} catch {
		return 1;
	}
}

export interface DesktopVaultSummary {
	name: string;
	empty: boolean;
	entries: number;
	/** Whether the app has a backup target for this vault. Absent from an older app. */
	backupTargets?: boolean;
}

export function useDesktopLink({
	from,
	onLinked,
}: {
	from: LinkFrom;
	/** Runs once the link is up, before the invite is looked at (Settings refreshes its status). */
	onLinked?: () => Promise<void> | void;
}) {
	const { desktopLink, storage, shell, crypto, files: platformFiles } = usePlatform();
	const { t } = useLingui();
	const vaultActions = useVaultActions();
	const { startJoin } = vaultActions;
	const { entries, files, conflicts } = useVault();
	const registry = useVaultRegistry();
	const { vaults, activeId } = registry;
	/** The provider's actions are bound to the vault open when they were made. After a join the
	 * desktop's vault is open, and only the actions of a render since then write to it. */
	const latest = useRef({ actions: vaultActions, registry });
	latest.current = { actions: vaultActions, registry };
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	/** An emoji link waiting on this screen's answer. */
	const [linking, setLinking] = useState<{ id: string; sas: PairingSas } | null>(null);
	/** This screen said they match; the link completes once the desktop app approves too. */
	const [awaitingApp, setAwaitingApp] = useState(false);
	/** The desktop app predates the emoji, so the code is the way to link. */
	const [legacy, setLegacy] = useState(false);
	const [code, setCode] = useState("");
	/** The invite the app handed over, waiting on the master password. */
	const [invite, setInvite] = useState<string | null>(null);
	const [outcome, setOutcome] = useState<LinkOutcome | null>(null);
	/** The vault that already syncs with the desktop's is the open one: linking stays in it. */
	const [sharedIsOpen, setSharedIsOpen] = useState(false);
	/** The desktop sent no vault after a link: Try again claims again. */
	const [claimFailed, setClaimFailed] = useState(false);
	/** A link this screen made that has not attached to a vault yet, let go if the screen goes. */
	const unattached = useRef(false);
	const [summary, setSummary] = useState<DesktopVaultSummary | null>(null);
	const [joining, setJoining] = useState(false);
	const [inviteError, setInviteError] = useState<string | null>(null);
	/** How this browser linked: only an emoji link may copy the vault over the link. */
	const [linkedBy, setLinkedBy] = useState<"emoji" | "code" | null>(null);
	/** The emoji an older desktop app asks to compare during a relay copy. */
	const [joinSas, setJoinSas] = useState<{ digits: string; emoji?: number[] } | null>(null);
	/** Other devices syncing this browser's vault: combining moves only this browser. */
	const [otherDevices, setOtherDevices] = useState<string[]>([]);
	/** What a combine left behind: look-alikes held back, and files it could not carry. */
	const [combined, setCombined] = useState<{
		heldBack: { items: EntryData[]; attachments: PlacedAttachment[] };
		uncarried: number;
		/** Entries set aside as unreadable in the old vault: never carried, kept where they are. */
		quarantined: number;
		/** Entries in a sync conflict: only the version on show came across. */
		conflicted: number;
		/** The old vault has to stay: some of it did not come across. */
		keptUnasked: boolean;
		/** Its alias provider or backup targets gave way to the desktop vault's own. */
		leftBehind: BroughtSettings["leftBehind"];
		/** Deleting the old vault is on offer, and what doing so checks. */
		pendingRemoval: { id: string; copied: CopiedOut } | null;
	} | null>(null);
	const [finishingCombine, setFinishingCombine] = useState(false);

	/** What linking does here, from what each side holds. */
	const outcomeFor = useCallback(
		async (claimed: string, desktop: DesktopVaultSummary | null): Promise<LinkOutcome> => {
			let shared: string | null = null;
			try {
				const { groupKey } = decodePairingCode(claimed.trim());
				for (const v of vaults) {
					const g = await storage.getMeta<{ groupKey?: string }>(syncKeyFor("sync.group", v.id));
					if (g?.groupKey === groupKey) shared = v.id;
				}
			} catch {
				// An undecodable code fails later with something specific; do not guess here.
			}
			const sharesGroup = shared !== null;
			setSharedIsOpen(sharesGroup && shared === activeId);
			let browser: LinkSide = "none";
			if (vaults.length > 0 && activeId) {
				const contents = await readVaultContents(storage, activeId, entries.length, files.length);
				browser = isVaultEmpty(contents) ? "empty" : "full";
				const group = await storage.getMeta<{
					roster?: { devices?: { publicKey: string; label: string }[] };
				}>(syncKeyFor("sync.group", activeId));
				const own = await shell.syncDevicePublicKey?.().catch(() => null);
				setOtherDevices(
					(group?.roster?.devices ?? []).filter((d) => d.publicKey !== own).map((d) => d.label),
				);
			}
			// An app that will not say is treated as holding something: asking is the safe side.
			const desktopSide = desktop?.empty === true ? "empty" : "full";
			return linkOutcome({ from, browser, desktop: desktopSide, sharesGroup });
		},
		[vaults, activeId, entries.length, files.length, storage, shell, from],
	);

	/** The summary first: the app answers it only while its invite is still armed. False when
	 * the app handed over no invite. */
	const afterLinked = useCallback(async (): Promise<boolean> => {
		await onLinked?.();
		const desktop = (await desktopLink?.vaultSummary?.().catch(() => null)) ?? null;
		setSummary(desktop);
		const claimed = await desktopLink?.claimSyncInvite?.().catch(() => null);
		if (!claimed) return false;
		setInviteError(null);
		setOutcome(await outcomeFor(claimed, desktop));
		setInvite(claimed);
		return true;
	}, [desktopLink, onLinked, outcomeFor]);

	const start = useCallback(async () => {
		if (!desktopLink) return;
		setBusy(true);
		setError(null);
		try {
			const started = desktopLink.start ? await desktopLink.start() : { legacy: true as const };
			if ("legacy" in started) setLegacy(true);
			else setLinking(started);
		} catch (e) {
			setError(e instanceof Error && e.message ? e.message : t`Could not reach the desktop app.`);
		} finally {
			setBusy(false);
		}
	}, [desktopLink, t]);

	/** After a link, the desktop's vault must follow: a pairing is never half made. */
	const claimAfterLink = useCallback(async () => {
		const claimed = await afterLinked();
		setClaimFailed(!claimed);
		setError(claimed ? null : t`The desktop app didn't send its vault.`);
	}, [afterLinked, t]);

	const retryClaim = useCallback(async () => {
		setBusy(true);
		try {
			await claimAfterLink();
		} finally {
			setBusy(false);
		}
	}, [claimAfterLink]);

	/** Close the vault's offer: the link it came with goes too, on both sides. */
	const abandon = useCallback(async () => {
		setInvite(null);
		setOutcome(null);
		setInviteError(null);
		setClaimFailed(false);
		if (!unattached.current) return;
		unattached.current = false;
		await desktopLink?.abandon?.();
	}, [desktopLink]);

	/** This screen's answer to the emoji. The app is trusted only after both screens say yes. */
	const answer = useCallback(
		async (matches: boolean) => {
			if (!linking || !desktopLink?.confirm) return;
			setBusy(true);
			setAwaitingApp(matches);
			setError(null);
			try {
				await desktopLink.confirm(linking.id, matches);
				unattached.current = true;
				setLinking(null);
				setLinkedBy("emoji");
				await claimAfterLink();
			} catch (e) {
				setLinking(null);
				setError(e instanceof Error && e.message ? e.message : t`Nothing was linked.`);
			} finally {
				setBusy(false);
				setAwaitingApp(false);
			}
		},
		[linking, desktopLink, claimAfterLink, t],
	);

	/** Link with the code, for a desktop app that predates the emoji. */
	const pairWithCode = useCallback(async () => {
		if (!desktopLink) return;
		setBusy(true);
		setError(null);
		try {
			await desktopLink.pair(code);
			unattached.current = true;
			setCode("");
			setLinkedBy("code");
			await claimAfterLink();
		} catch (e) {
			// The app refuses a wrong, expired and already-used code identically.
			setError(
				e instanceof Error && e.message ? e.message : t`The desktop app did not accept that code.`,
			);
		} finally {
			setBusy(false);
		}
	}, [desktopLink, code, claimAfterLink, t]);

	// A link nobody answered is let go when this screen goes away, rather than held open.
	const linkingRef = useRef(linking);
	linkingRef.current = linking;
	useEffect(
		() => () => {
			const open = linkingRef.current;
			if (open) void desktopLink?.cancel?.(open.id);
			// A link made here and not attached would be half a pairing.
			if (unattached.current) void desktopLink?.abandon?.();
		},
		[desktopLink],
	);

	// An older desktop app copies over the relay behind its own emoji prompt; show this side's.
	useEffect(
		() =>
			shell.onSyncEvent((e) => {
				if (e.kind === "sas" && e.sas) setJoinSas({ digits: e.sas, emoji: e.sasEmoji });
				else if (e.kind === "joined" || e.kind === "join-error") setJoinSas(null);
			}),
		[shell],
	);

	/** Wait for the render after a join, whose actions belong to the vault that just opened. */
	const vaultSwitchedFrom = useCallback(
		async (oldId: string | undefined) => {
			for (let i = 0; i < 200 && latest.current.registry.activeId === oldId; i++) {
				await new Promise((r) => setTimeout(r, 10));
			}
			if (latest.current.registry.activeId === oldId) {
				throw new Error(t`The desktop app's vault did not open.`);
			}
			return latest.current;
		},
		[t],
	);

	/**
	 * Join the desktop's vault over the link. The password is the one that vault uses: it wraps
	 * this browser's own copy, so the browser keeps working when the app is closed. The vault
	 * arrives under its own synced name.
	 *
	 * Combining reads this vault's entries and files BEFORE the switch, because only one vault's
	 * key is loaded at a time, then copies them in after it. The old vault then stays, set aside, and
	 * `combined` asks the user whether to delete it, unless deleting it would lose something by
	 * accident. Keeping them separate copies nothing.
	 */
	const accept = useCallback(
		async (
			password: string,
			opts?: { choice?: "combine" | "separate"; carry?: EntryData[] },
		): Promise<boolean> => {
			if (!invite) return false;
			setJoining(true);
			setInviteError(null);
			const combining = outcome === "combine" || (outcome === "ask" && opts?.choice === "combine");
			const oldId = activeId;
			// Counted now, while the old vault is the one open; the re-check before removal uses it.
			const oldCount = entries.length;
			const oldFiles = files.length;
			const oldConflicts = conflicts.size;
			// Past the join the invite form is gone, so a failure has to show in `error` instead.
			let joined = false;
			let copying = false;
			try {
				// Read first: a save landing while the files are staged must show as a change.
				const oldBlob =
					combining && oldId ? await storage.readVaultBlob(oldId).catch(() => null) : null;
				const carry =
					combining && oldId
						? await collectCarry(entries, files, platformFiles?.forVault(oldId) ?? null)
						: null;
				// Also read now, under the key about to go. Throws while the vault is still loading,
				// before anything has happened.
				const oldAlias = combining ? latest.current.actions.readSetting(PREF_ALIAS_PROVIDER) : null;
				const oldTargets =
					combining && oldId
						? await readCarriedTargets(
								await storage.getMeta<BackupTargetConfig[]>(backupTargetsKeyFor(oldId)),
								crypto.withVault?.(oldId) ?? crypto,
							)
						: [];
				const opened = await startJoin(invite, { kind: "password", password }, undefined, {
					viaLink: linkedBy === "emoji",
				});
				joined = true;
				setInvite(null);
				setOutcome(null);
				// The pairing is complete now: the link belongs to the vault the join opened. The
				// vault is here either way, so what the user chose for theirs still happens below.
				const attached = (await desktopLink?.attach?.(opened).catch(() => false)) ?? true;
				unattached.current = false;
				// Read before the attach, a link in progress is not linked yet.
				await Promise.resolve(onLinked?.()).catch(() => {});
				// Relinking the vault that already syncs with the desktop's opens no other.
				const now = opened === oldId ? latest.current : await vaultSwitchedFrom(oldId);
				if (carry && oldId && opened !== oldId) {
					copying = true;
					const placed = placeCarry(now.actions.readEntries(), carry);
					const fileHashes =
						placed.items.length || placed.attachments.length || placed.matched.length
							? await now.actions.importEntries(placed.items, placed.attachments, {
									ownVault: true,
									matched: placed.matched,
								})
							: [];
					copying = false;
					const brought: BroughtSettings =
						now.registry.activeId === opened
							? await bringSettings({
									alias: oldAlias,
									targets: oldTargets,
									desktopHasTargets: summary?.backupTargets === true,
									opened,
									actions: now.actions,
									storage,
									crypto,
								})
							: // Another vault opened meanwhile: what is open is not where these belong.
								{
									settings: [],
									leftBehind: { alias: false, backupTargets: false },
									failed: true,
								};
					// Deleting it is offered only where that can't lose something by accident: not with
					// what failed to copy or can't be read, nor a pairing that did not finish.
					const copyAtRisk =
						oldBlob === null ||
						placed.tagsLeftOver > 0 ||
						carry.uncarried > 0 ||
						brought.failed ||
						holdsQuarantine((await storage.readQuarantine?.(oldId)) ?? null);
					await now.registry.setAside(oldId);
					setCombined({
						heldBack: placed.heldBack,
						uncarried: carry.uncarried,
						quarantined: await countQuarantined(storage, oldId),
						conflicted: oldConflicts,
						keptUnasked: attached && copyAtRisk,
						leftBehind: brought.leftBehind,
						pendingRemoval:
							!attached || copyAtRisk
								? null
								: {
										id: oldId,
										copied: {
											blob: oldBlob,
											items: carry.items,
											fileHashes,
											settings: brought.settings,
										},
									},
					});
				}
				// After the join, so the copies land in the vault that is now open.
				if (opts?.carry?.length) await now.actions.importEntries(opts.carry);
				// Only once the desktop's vault is here, and only if it is still empty: nothing lost.
				if (outcome === "take" && oldId)
					await now.actions.deleteEmptyVault(oldId, oldCount, oldFiles);
				if (!attached) {
					setError(t`Linking didn't finish. Link again.`);
					return false;
				}
				return true;
			} catch (e) {
				const message = e instanceof Error && e.message ? e.message : null;
				if (copying) {
					setError(
						t`This vault's entries didn't copy into the desktop's vault. They are still in the old vault.`,
					);
				} else if (joined) {
					setError(message ?? t`Something went wrong after linking.`);
				} else {
					setInviteError(message ?? t`Could not sync with the desktop app.`);
				}
				return false;
			} finally {
				setJoining(false);
			}
		},
		[
			desktopLink,
			linkedBy,
			invite,
			outcome,
			activeId,
			entries,
			files,
			conflicts,
			platformFiles,
			crypto,
			summary,
			startJoin,
			vaultSwitchedFrom,
			storage,
			onLinked,
			t,
		],
	);

	/** Copy the look-alikes the dedup held back, as import's "Import them anyway" does. */
	const copyHeldBack = useCallback(async () => {
		if (!combined?.heldBack.items.length) return;
		const { heldBack, pendingRemoval } = combined;
		setFinishingCombine(true);
		setError(null);
		try {
			const hashes = await latest.current.actions.importEntries(
				heldBack.items,
				heldBack.attachments,
				{ ownVault: true },
			);
			setCombined({
				...combined,
				heldBack: { items: [], attachments: [] },
				pendingRemoval: pendingRemoval && {
					...pendingRemoval,
					copied: {
						...pendingRemoval.copied,
						fileHashes: [...pendingRemoval.copied.fileHashes, ...hashes],
					},
				},
			});
		} catch {
			setError(
				t`This vault's entries didn't copy into the desktop's vault. They are still in the old vault.`,
			);
		} finally {
			setFinishingCombine(false);
		}
	}, [combined, t]);

	/** The user said delete. Look-alikes still held back go with it, as the dialog told them. */
	const removeOldVault = useCallback(async () => {
		if (!combined?.pendingRemoval) return;
		const { id, copied } = combined.pendingRemoval;
		setFinishingCombine(true);
		setError(null);
		try {
			const removed = await latest.current.actions
				.deleteCarriedVault(id, {
					...copied,
					items: withoutHeldBack(copied.items, combined.heldBack.items),
				})
				.catch(() => false);
			setCombined(removed ? null : { ...combined, pendingRemoval: null, keptUnasked: true });
		} finally {
			setFinishingCombine(false);
		}
	}, [combined]);

	/** The user said keep it, or closed the dialog: it stays as it is, set aside. */
	const keepOldVault = useCallback(() => setCombined(null), []);

	return {
		busy,
		error,
		setError,
		linking,
		awaitingApp,
		legacy,
		code,
		setCode,
		invite,
		outcome,
		sharedIsOpen,
		summary,
		joining,
		inviteError,
		start,
		answer,
		pairWithCode,
		accept,
		abandon,
		claimFailed,
		retryClaim,
		combined,
		finishingCombine,
		copyHeldBack,
		removeOldVault,
		keepOldVault,
		otherDevices,
		joinSas,
		/** For the Settings poller-free path: an invite claimed elsewhere. */
		afterLinked,
	};
}
