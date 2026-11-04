// One link flow for the setup banner and Settings: compare emoji, learn what the desktop vault
// holds, claim its invite, then join over the link. See docs/desktop-link-onboarding.md.

import { useLingui } from "@lingui/react/macro";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePlatform } from "../../context/PlatformContext";
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
import { collectCarry, placeCarry } from "../../vault/combine-into";
import { isVaultEmpty, readVaultContents } from "../../vault/vault-empty";

export interface DesktopVaultSummary {
	name: string;
	empty: boolean;
	entries: number;
}

export function useDesktopLink({
	from,
	onLinked,
}: {
	from: LinkFrom;
	/** Runs once the link is up, before the invite is looked at (Settings refreshes its status). */
	onLinked?: () => Promise<void> | void;
}) {
	const { desktopLink, storage, shell, files: platformFiles } = usePlatform();
	const { t } = useLingui();
	const vaultActions = useVaultActions();
	const { startJoin, importEntries } = vaultActions;
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
	/** The desktop app predates the emoji, so the code is the way to link. */
	const [legacy, setLegacy] = useState(false);
	const [code, setCode] = useState("");
	/** The invite the app handed over, waiting on the master password. */
	const [invite, setInvite] = useState<string | null>(null);
	const [outcome, setOutcome] = useState<LinkOutcome | null>(null);
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
	} | null>(null);

	/** What linking does here, from what each side holds. */
	const outcomeFor = useCallback(
		async (claimed: string, desktop: DesktopVaultSummary | null): Promise<LinkOutcome> => {
			let sharesGroup = false;
			try {
				const { groupKey } = decodePairingCode(claimed.trim());
				for (const v of vaults) {
					const g = await storage.getMeta<{ groupKey?: string }>(syncKeyFor("sync.group", v.id));
					if (g?.groupKey === groupKey) sharesGroup = true;
				}
			} catch {
				// An undecodable code fails later with something specific; do not guess here.
			}
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

	/** The summary first: the app answers it only while its invite is still armed. */
	const afterLinked = useCallback(async () => {
		await onLinked?.();
		const desktop = (await desktopLink?.vaultSummary?.().catch(() => null)) ?? null;
		setSummary(desktop);
		const claimed = await desktopLink?.claimSyncInvite?.().catch(() => null);
		if (!claimed) return;
		setInviteError(null);
		setOutcome(await outcomeFor(claimed, desktop));
		setInvite(claimed);
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

	/** This screen's answer to the emoji. The app is trusted only after both screens say yes. */
	const answer = useCallback(
		async (matches: boolean) => {
			if (!linking || !desktopLink?.confirm) return;
			setBusy(true);
			setError(null);
			try {
				await desktopLink.confirm(linking.id, matches);
				setLinking(null);
				setLinkedBy("emoji");
				await afterLinked();
			} catch (e) {
				setLinking(null);
				setError(e instanceof Error && e.message ? e.message : t`Nothing was linked.`);
			} finally {
				setBusy(false);
			}
		},
		[linking, desktopLink, afterLinked, t],
	);

	/** Link with the code, for a desktop app that predates the emoji. */
	const pairWithCode = useCallback(async () => {
		if (!desktopLink) return;
		setBusy(true);
		setError(null);
		try {
			await desktopLink.pair(code);
			setCode("");
			setLinkedBy("code");
			await afterLinked();
		} catch (e) {
			// The app refuses a wrong, expired and already-used code identically.
			setError(
				e instanceof Error && e.message ? e.message : t`The desktop app did not accept that code.`,
			);
		} finally {
			setBusy(false);
		}
	}, [desktopLink, code, afterLinked, t]);

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
	 * key is loaded at a time, then copies them in after it. The old vault is kept, set aside.
	 * Keeping them separate copies nothing.
	 */
	const accept = useCallback(
		async (password: string, opts?: { choice?: "combine" | "separate"; carry?: EntryData[] }) => {
			if (!invite) return;
			setJoining(true);
			setInviteError(null);
			const combining = outcome === "combine" || (outcome === "ask" && opts?.choice === "combine");
			const oldId = activeId;
			// Counted now, while the old vault is the one open; the re-check before removal uses it.
			const oldCount = entries.length;
			const oldFiles = files.length;
			// Past the join the invite form is gone, so a failure has to show in `error` instead.
			let joined = false;
			let copying = false;
			try {
				const carry =
					combining && oldId
						? await collectCarry(entries, files, platformFiles?.forVault(oldId) ?? null)
						: null;
				await startJoin(invite, { kind: "password", password }, undefined, {
					viaLink: linkedBy === "emoji",
				});
				joined = true;
				setInvite(null);
				setOutcome(null);
				const now = await vaultSwitchedFrom(oldId);
				if (carry && oldId) {
					copying = true;
					const placed = placeCarry(now.actions.readEntries(), carry);
					if (placed.items.length || placed.attachments.length) {
						await now.actions.importEntries(placed.items, placed.attachments);
					}
					await now.registry.setAside(oldId);
					setCombined({ heldBack: placed.heldBack, uncarried: carry.uncarried });
				}
				// After the join, so the copies land in the vault that is now open.
				if (opts?.carry?.length) await now.actions.importEntries(opts.carry);
				// Only once the desktop's vault is here, and only if it is still empty: nothing lost.
				if (outcome === "take" && oldId)
					await now.actions.deleteEmptyVault(oldId, oldCount, oldFiles);
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
			} finally {
				setJoining(false);
			}
		},
		[
			linkedBy,
			invite,
			outcome,
			activeId,
			entries,
			files,
			platformFiles,
			startJoin,
			vaultSwitchedFrom,
			t,
		],
	);

	/** Copy the look-alikes the dedup held back, as import's "Import them anyway" does. */
	const copyHeldBack = useCallback(async () => {
		if (!combined?.heldBack.items.length) return;
		await latest.current.actions.importEntries(
			combined.heldBack.items,
			combined.heldBack.attachments,
		);
		setCombined({ ...combined, heldBack: { items: [], attachments: [] } });
	}, [combined]);

	const dismissInvite = useCallback(() => {
		setInvite(null);
		setOutcome(null);
		setInviteError(null);
	}, []);

	return {
		busy,
		error,
		setError,
		linking,
		legacy,
		code,
		setCode,
		invite,
		outcome,
		summary,
		joining,
		inviteError,
		start,
		answer,
		pairWithCode,
		accept,
		dismissInvite,
		combined,
		copyHeldBack,
		otherDevices,
		joinSas,
		/** For the Settings poller-free path: an invite claimed elsewhere. */
		afterLinked,
	};
}
