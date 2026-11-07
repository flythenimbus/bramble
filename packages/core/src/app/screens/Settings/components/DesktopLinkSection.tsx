import { Trans, useLingui } from "@lingui/react/macro";
import { CheckCircle2, ExternalLink, Monitor, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { DesktopLinkStatus } from "../../../../adapters/desktop-link";
import { usePlatform } from "../../../../context/PlatformContext";
import { useVault } from "../../../../hooks/useVault";
import { useVaultRegistry } from "../../../../hooks/useVaultRegistry";
import { formatDate } from "../../../../util/format-date";
import { displayLabel } from "../../../../vault/vault-registry";
import { SasDisplay } from "../../../components/SasDisplay";
import { Button } from "../../../components/ui/button";
import { InlineConfirm } from "../../../components/ui/inline-confirm";
import { Modal } from "../../../components/ui/modal";
import { PasswordField } from "../../../components/ui/password-field";
import { TextField } from "../../../components/ui/text-field";
import { useDesktopLink } from "../../../hooks/useDesktopLink";
import { usePopOut } from "../../../hooks/usePopOut";
import { CombineResult } from "./CombineResult";
import { HiddenVaultRow } from "./HiddenVaultRow";
import { Row, Section } from "./primitives";
import { OtherDevicesWarning, type TwoVaultsChoice, TwoVaultsPrompt } from "./TwoVaultsPrompt";

/** Codes are 8 characters from an alphabet with no lookalikes; see the desktop app's
 * pairing.rs. Anything longer is a paste that picked up whitespace. */
const CODE_LENGTH = 8;

/** Link this browser to the Bramble desktop app. Rendered only where the platform provides a
 * desktop-link adapter, which today is the extension. See docs/desktop-port.md. */
export function DesktopLinkSection() {
	const { desktopLink, storage } = usePlatform();
	const { t } = useLingui();
	const { entries } = useVault();
	const { syncKey, vaults, hiddenVaults, activeId } = useVaultRegistry();
	// The toolbar popup closes the moment the user switches to the desktop app, which a join asks
	// them to do, and the vault it was receiving goes with it. So that much runs in a window.
	const { canPopOut, popOut } = usePopOut();
	/**
	 * Whether the vault on screen is one the desktop app shares.
	 *
	 * The link is per-BROWSER and a sync group is per-VAULT, so "Connected" was true of the
	 * browser while implying something about whichever vault you were standing in. Undefined
	 * while unknown (the app may not be running), which the copy treats as "cannot say".
	 */
	const [sharesThisVault, setSharesThisVault] = useState<boolean | undefined>(undefined);
	const [status, setStatus] = useState<DesktopLinkStatus | null>(null);
	/**
	 * Whether the browser currently allows the link. Undefined while unknown, and true where the
	 * host has no runtime permission to ask for (mobile, desktop, a build that requires it), which
	 * is why absence reads as allowed rather than denied.
	 */
	const [allowed, setAllowed] = useState<boolean | undefined>(undefined);
	const [invitePassword, setInvitePassword] = useState("");
	/** Guards the local verb, so its wording is read before it is used. */
	const [confirmUnlink, setConfirmUnlink] = useState(false);
	const [unlinking, setUnlinking] = useState(false);
	/** Combine or keep separate, when both sides hold entries. Nothing until the user picks. */
	const [choice, setChoice] = useState<TwoVaultsChoice | null>(null);

	const refresh = useCallback(async () => {
		if (!desktopLink) return;
		try {
			setStatus(await desktopLink.status());
			// No sub-adapter means nothing to ask for, which is a grant, not a refusal.
			setAllowed(desktopLink.permission ? await desktopLink.permission.granted() : true);
		} catch (e) {
			setRefreshError(String(e));
		}
	}, [desktopLink]);
	const [refreshError, setRefreshError] = useState<string | null>(null);

	const link = useDesktopLink({ from: "settings", onLinked: refresh });
	const busy = link.busy || unlinking;

	/**
	 * Ask for the browser permission, then reload so the grant is usable.
	 *
	 * The reload is not cosmetic. Chromium fixes a context's API bindings when the context is
	 * created, so the page that asks for a permission never gains the API it just unlocked, and
	 * neither does the background worker that was already running. Only a context created
	 * afterwards has it, and pairing borrows this page's. See
	 * docs/desktop-link-optional-permission.md.
	 *
	 * In the toolbar popup the browser's prompt takes focus and tears the popup down, so this
	 * function simply stops existing mid-call; the grant still lands, and reopening the popup is
	 * itself the fresh context. Nothing here has to handle that, but nothing may ASSUME it either,
	 * which is why the caller never treats "did not return" as failure.
	 */
	const requestPermission = useCallback(async () => {
		if (!desktopLink?.permission) return;
		link.setError(null);
		const granted = await desktopLink.permission.request().catch(() => false);
		if (granted) location.reload();
		else link.setError(t`Bramble needs that permission to talk to the desktop app.`);
	}, [desktopLink, link, t]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	// Ask the app who it is and look for it in THIS vault's roster. The comparison happens here,
	// against a roster this browser already holds, so the app discloses nothing about its vaults.
	// Deliberately not derived from the live sync session: that answers "is it syncing right now",
	// which reads as "not shared" whenever the app simply is not running.
	useEffect(() => {
		if (!desktopLink?.desktopSyncKey || !status?.paired) return;
		let cancelled = false;
		void (async () => {
			const key = await desktopLink.desktopSyncKey?.().catch(() => null);
			if (cancelled) return;
			if (!key) return setSharesThisVault(undefined);
			const group = await storage
				.getMeta<{ roster?: { devices?: { publicKey: string }[] } }>(syncKey("sync.group"))
				.catch(() => undefined);
			if (cancelled) return;
			setSharesThisVault((group?.roster?.devices ?? []).some((d) => d.publicKey === key));
		})();
		return () => {
			cancelled = true;
		};
	}, [desktopLink, status?.paired, storage, syncKey]);

	// What the user chose belongs to the invite: a mistyped password keeps it for the retry.
	useEffect(() => {
		if (link.invite) return;
		setChoice(null);
	}, [link.invite]);

	if (!desktopLink) return null;

	const unlink = async () => {
		setUnlinking(true);
		try {
			const { remaining } = await desktopLink.unlink();
			// Hand the permission back with the last link. Severing it should return what it needed,
			// rather than leaving a browser that can still talk to local programs for a feature it
			// is no longer using; another vault's link still needs it. Best-effort: failing to give
			// it back must not fail the unlink, which has already happened.
			if (remaining === 0) await desktopLink.permission?.drop().catch(() => {});
			setConfirmUnlink(false);
			await refresh();
		} finally {
			setUnlinking(false);
		}
	};

	/**
	 * Build this browser's own copy of the desktop's vault from the claimed invite.
	 *
	 * The password is the one the desktop's vault uses: it wraps the local copy, so the browser
	 * keeps working when the app is closed.
	 */
	const acceptInvite = async () => {
		await link.accept(invitePassword, { choice: choice ?? undefined });
		setInvitePassword("");
	};

	const outcome = link.outcome;
	const activeIndex = vaults.findIndex((v) => v.id === activeId);
	const browserName = displayLabel(vaults[activeIndex]?.label ?? "", Math.max(0, activeIndex));
	const desktopName = link.summary?.name ?? t`the desktop app's vault`;
	const error = link.error ?? refreshError;

	const emojiConfirm = link.linking && (
		<div className="space-y-3 text-center">
			<p className="text-sm">
				<Trans>Check these match your desktop app</Trans>
			</p>
			<SasDisplay digits={link.linking.sas.digits} emoji={link.linking.sas.emoji} large />
			{link.awaitingApp ? (
				<p className="text-sm text-muted-foreground">
					<Trans>Waiting for the desktop app…</Trans>
				</p>
			) : (
				<>
					<p className="text-xs text-muted-foreground">
						<Trans>
							Confirm here and approve in the desktop app, only if both show the same symbols.
						</Trans>
					</p>
					<div className="flex justify-center gap-2">
						<Button
							variant="secondary"
							size="sm"
							disabled={busy}
							onClick={() => void link.answer(false)}
						>
							<Trans>They don't match</Trans>
						</Button>
						<Button size="sm" disabled={busy} onClick={() => void link.answer(true)}>
							<Trans>They match</Trans>
						</Button>
					</div>
				</>
			)}
		</div>
	);

	const continueInWindow = (
		<Button variant="secondary" fullWidth onClick={() => popOut()}>
			<ExternalLink className="w-4 h-4" />
			<Trans>Continue in a window</Trans>
		</Button>
	);

	return (
		<Section icon={<Monitor className="w-4 h-4" />} title={t`Desktop app`}>
			{status?.paired && status.permitted === false ? (
				// Paired and unusable: the permission was taken away in the browser's own settings,
				// which nothing in this UI would otherwise reveal. Only an explicit false, so a host
				// that never reports it is never accused. The pairing keys are untouched, so this is
				// one grant away from working and must not read as "disconnected".
				<Row
					icon={<TriangleAlert className="w-4 h-4 text-destructive" />}
					title={t`Permission needed`}
					subtitle={t`The desktop app is still linked, but this browser's permission to talk to it was turned off.`}
				>
					<Button
						variant="primary"
						size="sm"
						disabled={busy}
						onClick={() => void requestPermission()}
					>
						<Trans>Allow again</Trans>
					</Button>
				</Row>
			) : status?.paired ? (
				<>
					<Row
						icon={<CheckCircle2 className="w-4 h-4 text-primary" />}
						title={t`Connected`}
						subtitle={
							// Says what the link IS: a browser-wide connection. Whether this particular
							// vault rides it is the separate fact underneath.
							sharesThisVault === true
								? t`This vault syncs with the desktop app.`
								: status.pairedAt
									? t`Linked ${formatDate(status.pairedAt)}`
									: t`Linked to the Bramble desktop app.`
						}
					>
						{/* Two different things can be meant by "disconnect", and only one of them is
					    this one. Stopping the app link is local and reversible; REMOVING this
					    browser from the vault is a roster change every device sees, and it lives
					    with the devices under Device sync. Saying which this is, and what it does
					    not do, is the whole point of the confirmation. */}
						<InlineConfirm
							variant="destructiveOutline"
							armed={confirmUnlink}
							onArmedChange={setConfirmUnlink}
							confirmLabel={<Trans>Stop using the app</Trans>}
							onConfirm={unlink}
							trigger={(arm) => (
								<Button variant="ghost" size="sm" disabled={busy} onClick={arm}>
									<Trans>Disconnect</Trans>
								</Button>
							)}
						/>
					</Row>
					{confirmUnlink && (
						<p className="text-xs text-muted-foreground">
							<Trans>
								Stops filling and unlocking through the desktop app on this browser. This vault
								keeps syncing with it, and nothing is deleted anywhere. To take this browser out of
								the vault entirely, remove it from the device list under Device sync.
							</Trans>
						</p>
					)}
				</>
			) : canPopOut ? (
				<div className="space-y-3">
					<p className="text-sm text-muted-foreground">
						<Trans>
							Connecting continues in a window, which stays open while you switch to the desktop
							app.
						</Trans>
					</p>
					{continueInWindow}
				</div>
			) : allowed === false ? (
				// Declared but not held. Asked for here rather than at install, so the permission
				// warning lands on people who actually use the desktop app instead of everyone.
				<div className="space-y-3">
					<p className="text-sm text-muted-foreground">
						<Trans>
							Bramble needs your permission to talk to the desktop app on this computer. Your
							browser will ask you to confirm.
						</Trans>
					</p>
					<Button variant="primary" fullWidth onClick={() => void requestPermission()}>
						<Trans>Allow and continue</Trans>
					</Button>
				</div>
			) : link.linking ? (
				emojiConfirm
			) : !link.legacy ? (
				<div className="space-y-3">
					<p className="text-sm text-muted-foreground">
						<Trans>
							Open Bramble on this computer, go to Settings and choose Connect a browser, then press
							Link here. Both screens will show the same symbols.
						</Trans>
					</p>
					<Button variant="primary" fullWidth disabled={busy} onClick={() => void link.start()}>
						<Trans>Link</Trans>
					</Button>
				</div>
			) : (
				<div className="space-y-3">
					<p className="text-sm text-muted-foreground">
						<Trans>
							This desktop app links with a code. Enter the one its Connect a browser screen shows.
						</Trans>
					</p>
					<TextField
						label={t`Code from the desktop app`}
						value={link.code}
						autoComplete="off"
						spellCheck={false}
						// The alphabet is uppercase; the app folds case anyway, but showing it the
						// way it is displayed avoids a mismatch the user cannot see.
						onChange={(e) => link.setCode(e.target.value.toUpperCase().trim())}
						onKeyDown={(e) => {
							if (e.key === "Enter" && link.code.length === CODE_LENGTH) void link.pairWithCode();
						}}
						className="font-mono tracking-widest"
					/>
					<Button
						variant="primary"
						fullWidth
						disabled={busy || link.code.length !== CODE_LENGTH}
						onClick={() => void link.pairWithCode()}
					>
						<Trans>Connect</Trans>
					</Button>
				</div>
			)}

			{error && <p className="text-xs text-destructive">{error}</p>}
			{link.claimFailed && (
				<Button
					variant="secondary"
					size="sm"
					disabled={busy}
					onClick={() => void link.retryClaim()}
				>
					<Trans>Try again</Trans>
				</Button>
			)}
			{hiddenVaults
				.filter((v) => v.id !== link.combined?.pendingRemoval?.id)
				.map((v, i) => (
					<HiddenVaultRow key={v.id} vault={v} index={i} />
				))}
			{link.combined && <CombineResult link={link} />}
			<Modal open={link.copyingOver} onClose={() => {}} dismissable={false} className="max-w-sm">
				<p className="p-5 text-sm text-muted-foreground">
					<Trans>Copying into the desktop's vault…</Trans>
				</p>
			</Modal>
			<Modal
				open={link.invite !== null}
				// No "Not now": a link without the vault is half a pairing, so closing lets it go.
				onClose={() => {
					void link.abandon();
					setInvitePassword("");
				}}
				className="max-w-sm"
			>
				<form
					className="p-5 space-y-4"
					onSubmit={(e) => {
						e.preventDefault();
						void acceptInvite();
					}}
				>
					<h2 className="text-base font-medium">
						{outcome === "switch" ? (
							<Trans>You already share this vault</Trans>
						) : outcome === "ask" ? (
							<Trans>You have two vaults</Trans>
						) : outcome === "add" ? (
							<Trans>Add the desktop's vault</Trans>
						) : (
							<Trans>Sync with the desktop app</Trans>
						)}
					</h2>
					{outcome === "switch" ? (
						// Nothing transfers and no vault is created: this browser is already in that
						// group. All that changes is which vault is open, so say that and ask, rather
						// than moving the user and leaving them to work out where they landed.
						<p className="text-xs text-muted-foreground">
							{link.sharedIsOpen ? (
								<Trans>This vault already syncs with the desktop app.</Trans>
							) : (
								<Trans>
									This browser already shares that vault with the desktop app. Opening it just
									switches you to it; the vault you are in now stays exactly as it is.
								</Trans>
							)}
						</p>
					) : (
						<>
							{outcome === "ask" ? (
								<TwoVaultsPrompt
									browserName={browserName}
									browserEntries={entries.length}
									desktopName={desktopName}
									desktopEntries={link.summary?.entries ?? null}
									otherDevices={link.otherDevices}
									choice={choice}
									onChoice={setChoice}
								/>
							) : (
								<p className="text-xs text-muted-foreground">
									{outcome === "add" ? (
										<Trans>
											This adds the desktop's vault to this browser as a separate one. Your existing
											vaults stay as they are.
										</Trans>
									) : outcome === "combine" ? (
										<Trans>
											This browser's entries and files move into {desktopName}, and this browser
											will unlock with its master password.
										</Trans>
									) : (
										<Trans>
											The desktop app offered to share its vault with this browser. Enter the master
											password you use there.
										</Trans>
									)}
								</p>
							)}
							{outcome === "combine" && (
								<OtherDevicesWarning browserName={browserName} otherDevices={link.otherDevices} />
							)}
							<PasswordField
								label={t`Master password`}
								value={invitePassword}
								autoFocus
								onChange={(e) => setInvitePassword(e.target.value)}
							/>
						</>
					)}
					{link.joinSas && (
						<>
							<p className="text-xs text-muted-foreground">
								<Trans>
									The desktop app is showing the same symbols and waiting for you to approve there.
									Approve only if they match.
								</Trans>
							</p>
							<SasDisplay digits={link.joinSas.digits} emoji={link.joinSas.emoji} />
						</>
					)}
					{link.inviteError && <p className="text-xs text-destructive">{link.inviteError}</p>}
					<div className="flex justify-end gap-2">
						<Button
							type="submit"
							size="sm"
							disabled={
								link.joining ||
								(outcome !== "switch" && !invitePassword) ||
								(outcome === "ask" && choice === null)
							}
						>
							{link.joining ? (
								<Trans>Waiting for the desktop app…</Trans>
							) : outcome === "switch" ? (
								link.sharedIsOpen ? (
									<Trans>Link</Trans>
								) : (
									<Trans>Open that vault</Trans>
								)
							) : outcome === "ask" ? (
								<Trans>Continue</Trans>
							) : (
								<Trans>Sync</Trans>
							)}
						</Button>
					</div>
				</form>
			</Modal>
		</Section>
	);
}
