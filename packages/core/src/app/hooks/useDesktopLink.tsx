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
import { sha256Hex } from "../../util/hash";
import {
	type CarriedTarget,
	collectCarry,
	placeCarry,
	readCarriedTargets,
	sameBytes,
	sealCarriedTargets,
} from "../../vault/combine-into";
import { holdsQuarantine, isVaultEmpty, readVaultContents } from "../../vault/vault-empty";

/** What came across besides entries and files, and what stayed behind the desktop's own. */
interface BroughtSettings {
	leftBehind: { alias: boolean; backupTargets: boolean };
	failed: boolean;
}

const sameAlias = (a: unknown, b: unknown) =>
	isAliasConfig(a) && isAliasConfig(b)
		? sameAliasConfig(a, b)
		: JSON.stringify(a) === JSON.stringify(b);

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
		leftBehind: { alias: false, backupTargets: false },
		failed: false,
	};
	// Apart, so one failing still brings the other.
	try {
		// Any stored value counts, shaped like a provider this build knows or not: extension and app
		// version independently, and a newer one's must neither be overwritten nor lost.
		if (alias != null) {
			const own = actions.readSetting(PREF_ALIAS_PROVIDER);
			if (own == null) {
				await actions.writeSetting(PREF_ALIAS_PROVIDER, alias);
			} else if (!sameAlias(alias, own)) {
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
	const { entries, files } = useVault();
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
	/** What a combine has to say: what it held back or left behind, and whether the old vault stays
	 * listed. Null when all of it came across, which needs no word. */
	const [combined, setCombined] = useState<{
		heldBack: { items: EntryData[]; attachments: PlacedAttachment[] };
		uncarried: number;
		/** Entries set aside as unreadable in the old vault: never carried, kept where they are. */
		quarantined: number;
		/** Entries in a sync conflict: only the version on show came across. */
		conflicted: number;
		/** The old vault is off the list. Nothing deletes it. */
		hidden: boolean;
		/** Some of it did not come across, so the old vault stays listed. */
		copyFailed: boolean;
		/** Settings that gave way to the desktop vault's own, and backup targets that won't open. */
		leftBehind: BroughtSettings["leftBehind"] & { unreadableTargets: number };
	} | null>(null);
	const [finishingCombine, setFinishingCombine] = useState(false);
	/** The copy is running: the invite's form has gone and the result's dialog isn't up yet. */
	const [copyingOver, setCopyingOver] = useState(false);

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
				// From the disk: a login saved in another window never reaches this one's memory.
				const disk = await latest.current.actions.readOpenVaultFromDisk().catch(() => null);
				const contents = await readVaultContents(
					storage,
					activeId,
					disk ? disk.entries.length + disk.unreadable : entries.length,
					disk ? disk.files.length : files.length,
				);
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
	 * key is loaded at a time, then copies them in after it. From the disk, not memory: a login saved
	 * in another window never reaches this one, and the check before deleting would pass without it.
	 * `combined` then asks the user whether to delete the old vault, hidden meanwhile unless something
	 * stayed behind in it. Where deleting could lose something by accident it isn't on offer. Keeping
	 * them separate copies nothing.
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
			// Past the join the invite form is gone, so a failure has to show in `error` instead.
			let joined = false;
			let copying = false;
			let oldKeyToDrop: string | null = null;
			try {
				const taking = outcome === "take";
				// Read first: a save landing while the files are staged must show as a change.
				const oldBlob =
					(combining || taking) && oldId
						? await storage.readVaultBlob(oldId).catch(() => null)
						: null;
				// Throws while the vault is still loading, before anything has happened. An empty vault
				// that can't be read is just not removed.
				const onDisk =
					combining && oldId
						? await latest.current.actions.readOpenVaultFromDisk()
						: taking && oldId
							? await latest.current.actions.readOpenVaultFromDisk().catch(() => null)
							: null;
				const carry =
					combining && oldId && onDisk
						? await collectCarry(
								onDisk.entries,
								onDisk.files,
								platformFiles?.forVault(oldId) ?? null,
							)
						: null;
				const oldAlias = onDisk?.settings?.[PREF_ALIAS_PROVIDER]?.value;
				// Read now, under the key about to go.
				const oldTargets =
					combining && oldId
						? await readCarriedTargets(
								await storage.getMeta<BackupTargetConfig[]>(backupTargetsKeyFor(oldId)),
								crypto.withVault?.(oldId) ?? crypto,
							)
						: { targets: [], unreadable: 0 };
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
				if (carry && onDisk && oldId && opened !== oldId) {
					oldKeyToDrop = oldId;
					copying = true;
					setCopyingOver(true);
					const placed = placeCarry(now.actions.readEntries(), carry);
					if (placed.items.length || placed.attachments.length || placed.matched.length) {
						await now.actions.importEntries(placed.items, placed.attachments, {
							ownVault: true,
							matched: placed.matched,
						});
					}
					copying = false;
					// After the import, which can take a while: is what's open still where this belongs?
					const afterCopy = latest.current;
					const brought: BroughtSettings =
						afterCopy.registry.activeId === opened
							? await bringSettings({
									alias: oldAlias,
									targets: oldTargets.targets,
									desktopHasTargets: summary?.backupTargets === true,
									opened,
									actions: afterCopy.actions,
									storage,
									crypto,
								})
							: { leftBehind: { alias: false, backupTargets: false }, failed: true };
					// Off the list once all of it came across. With what failed to copy or can't be read,
					// or a pairing that did not finish, it stays listed, since it may hold the only copy.
					const copyAtRisk =
						oldBlob === null ||
						placed.tagsLeftOver > 0 ||
						carry.uncarried > 0 ||
						onDisk.unreadable > 0 ||
						brought.failed ||
						// A save during the join isn't in the copy.
						!sameBytes(await storage.readVaultBlob(oldId), oldBlob) ||
						holdsQuarantine((await storage.readQuarantine?.(oldId)) ?? null);
					const hidden = attached && !copyAtRisk;
					if (hidden) {
						await afterCopy.registry.hide(oldId, {
							blobHash: await sha256Hex(oldBlob),
							into: opened,
						});
					}
					const leftBehind = { ...brought.leftBehind, unreadableTargets: oldTargets.unreadable };
					const toSay =
						!hidden ||
						placed.heldBack.items.length > 0 ||
						onDisk.conflicted > 0 ||
						leftBehind.alias ||
						leftBehind.backupTargets ||
						leftBehind.unreadableTargets > 0;
					if (toSay) {
						setCombined({
							heldBack: placed.heldBack,
							uncarried: carry.uncarried,
							quarantined: await countQuarantined(storage, oldId),
							conflicted: onDisk.conflicted,
							hidden,
							copyFailed: attached && copyAtRisk,
							leftBehind,
						});
					}
				}
				// After the join, so the copies land in the vault that is now open.
				if (opts?.carry?.length) await now.actions.importEntries(opts.carry);
				// Only once the desktop's vault is here, and only if it is still empty: nothing lost.
				if (taking && oldId && oldBlob) {
					// Counted from the disk. One it couldn't read counts as holding something.
					await now.actions.deleteEmptyVault(
						oldId,
						onDisk ? onDisk.entries.length + onDisk.unreadable : 1,
						onDisk ? onDisk.files.length : 0,
						oldBlob,
					);
				}
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
				// Copied or not, nothing needs its key now, and it should not stay in memory.
				if (oldKeyToDrop) {
					await crypto
						.withVault?.(oldKeyToDrop)
						.lock()
						.catch(() => {});
				}
				setJoining(false);
				setCopyingOver(false);
			}
		},
		[
			desktopLink,
			linkedBy,
			invite,
			outcome,
			activeId,
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
		const { heldBack } = combined;
		setFinishingCombine(true);
		setError(null);
		try {
			await latest.current.actions.importEntries(heldBack.items, heldBack.attachments, {
				ownVault: true,
			});
			setCombined({ ...combined, heldBack: { items: [], attachments: [] } });
		} catch {
			setError(
				t`This vault's entries didn't copy into the desktop's vault. They are still in the old vault.`,
			);
		} finally {
			setFinishingCombine(false);
		}
	}, [combined, t]);

	const closeCombined = useCallback(() => setCombined(null), []);

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
		closeCombined,
		copyingOver,
		otherDevices,
		joinSas,
		/** For the Settings poller-free path: an invite claimed elsewhere. */
		afterLinked,
	};
}
