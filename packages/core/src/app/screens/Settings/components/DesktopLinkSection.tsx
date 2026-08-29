import { Trans, useLingui } from "@lingui/react/macro";
import { CheckCircle2, Monitor, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { DesktopLinkStatus } from "../../../../adapters/desktop-link";
import { usePlatform } from "../../../../context/PlatformContext";
import { useVault, useVaultActions } from "../../../../hooks/useVault";
import { useVaultRegistry } from "../../../../hooks/useVaultRegistry";
import { decodePairingCode } from "../../../../sync/enrollment";
import { syncKeyFor } from "../../../../sync/sync-keys";
import { formatDate } from "../../../../util/format-date";
import { SasDisplay } from "../../../components/SasDisplay";
import { Button } from "../../../components/ui/button";
import { Modal } from "../../../components/ui/modal";
import { PasswordField } from "../../../components/ui/password-field";
import { TextField } from "../../../components/ui/text-field";
import { Row, Section } from "./primitives";

/** Codes are 8 characters from an alphabet with no lookalikes; see the desktop app's
 * pairing.rs. Anything longer is a paste that picked up whitespace. */
const CODE_LENGTH = 8;

/** How often a linked browser asks whether the app is offering to share its vault. Slack because
 * each check is a round trip that can spawn a host process; the app arms an invite for minutes. */
const OFFER_POLL_MS = 4000;

/** Link this browser to the Bramble desktop app. Rendered only where the platform provides a
 * desktop-link adapter, which today is the extension. See docs/desktop-port.md. */
export function DesktopLinkSection() {
	const { desktopLink, shell, storage } = usePlatform();
	const { t } = useLingui();
	const { startJoin, importEntries } = useVaultActions();
	const { entries } = useVault();
	const { vaults, syncKey } = useVaultRegistry();
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
	const [code, setCode] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	/** The invite the app handed over, waiting on the master password that unlocks the copy. */
	const [invite, setInvite] = useState<string | null>(null);
	const [invitePassword, setInvitePassword] = useState("");
	const [inviteError, setInviteError] = useState<string | null>(null);
	const [joining, setJoining] = useState(false);
	/** Guards the local verb, so its wording is read before it is used. */
	const [confirmUnlink, setConfirmUnlink] = useState(false);
	/** The SAS for the join in flight. The inviter is holding on the user's answer, so without
	 * this the modal is a disabled button and the only way past it is approving something on the
	 * other screen that has not been compared with anything. */
	const [joinSas, setJoinSas] = useState<{ sas: string; sasEmoji?: number[] } | null>(null);
	/**
	 * What accepting will actually do to this browser, worked out before anything moves.
	 *
	 * "switch" means a vault here already syncs that group, so this only changes which one is
	 * open. "add" means a new vault appears alongside the ones already here. "first" means this
	 * browser has no vaults at all. The distinction is the whole point: a settings action started
	 * inside one vault must not silently leave the user standing in another.
	 */
	const [outcome, setOutcome] = useState<"switch" | "add" | "first" | null>(null);
	/** Whether to carry this vault's entries into the shared one rather than leave two apart. */
	const [alsoMove, setAlsoMove] = useState(false);

	const refresh = useCallback(async () => {
		if (!desktopLink) return;
		try {
			setStatus(await desktopLink.status());
			// No sub-adapter means nothing to ask for, which is a grant, not a refusal.
			setAllowed(desktopLink.permission ? await desktopLink.permission.granted() : true);
		} catch (e) {
			setError(String(e));
		}
	}, [desktopLink]);

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
		setError(null);
		const granted = await desktopLink.permission.request().catch(() => false);
		if (granted) location.reload();
		else setError(t`Bramble needs that permission to talk to the desktop app.`);
	}, [desktopLink, t]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	/** Which of the three things accepting this invite would do. */
	const outcomeFor = useCallback(
		async (pairingCode: string): Promise<"switch" | "add" | "first"> => {
			try {
				const { groupKey } = decodePairingCode(pairingCode.trim());
				for (const v of vaults) {
					const g = await storage.getMeta<{ groupKey?: string }>(syncKeyFor("sync.group", v.id));
					// The same check startJoin makes, run early so the user is told rather than moved.
					if (g?.groupKey === groupKey) return "switch";
				}
			} catch {
				// An undecodable code fails later with something specific; do not guess here.
			}
			return vaults.length === 0 ? "first" : "add";
		},
		[vaults, storage],
	);

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

	// The joiner's half of the comparison. Raised once the channel is authenticated and cleared
	// when the join settles either way, so a retry never shows a stale one.
	useEffect(() => {
		return shell.onSyncEvent((e) => {
			if (e.kind === "sas" && e.sas) setJoinSas({ sas: e.sas, sasEmoji: e.sasEmoji });
			else if (e.kind === "joined" || e.kind === "join-error") setJoinSas(null);
		});
	}, [shell]);

	/**
	 * Watch for an invite the app has armed, for a browser that is ALREADY linked.
	 *
	 * The claim used to happen only inside `pair()`, so a browser linked before this existed could
	 * never pick up the sync half: the app armed an invite, the user waited, and nothing on this
	 * side ever asked. Which is every browser paired with the old two-step flow.
	 *
	 * Polled rather than pushed, and only while this section is on screen, because claiming is what
	 * consumes the invite: doing it in the background would burn an offer with nobody looking at
	 * the prompt it raises. The interval is slack because each check is a round trip to the app,
	 * which spawns a host process when sync is not already holding the pipe open.
	 */
	useEffect(() => {
		if (!desktopLink?.claimSyncInvite || !status?.paired || invite !== null) return;
		let cancelled = false;
		const check = async () => {
			const claimed = await desktopLink.claimSyncInvite?.().catch(() => null);
			if (cancelled || !claimed) return;
			setInvitePassword("");
			setInviteError(null);
			setOutcome(await outcomeFor(claimed));
			setInvite(claimed);
		};
		void check();
		const id = setInterval(() => void check(), OFFER_POLL_MS);
		return () => {
			cancelled = true;
			clearInterval(id);
		};
	}, [desktopLink, status?.paired, invite, outcomeFor]);

	if (!desktopLink) return null;

	const pair = async () => {
		setBusy(true);
		setError(null);
		try {
			await desktopLink.pair(code);
			setCode("");
			await refresh();
			// The app arms a sync invite when the user clicks Connect, so one code does both
			// halves: the link this browser delegates over, and a copy of the vault itself.
			// Absent is ordinary (an older app, or its dialog already closed) and leaves the link
			// working on its own.
			const claimed = await desktopLink.claimSyncInvite?.().catch(() => null);
			if (claimed) {
				setInvitePassword("");
				setInviteError(null);
				setOutcome(await outcomeFor(claimed));
				setInvite(claimed);
			}
		} catch (e) {
			// The app refuses a wrong, expired and already-used code identically, so there is
			// nothing more specific to say here than that it did not take.
			setError(
				e instanceof Error && e.message ? e.message : t`The desktop app did not accept that code.`,
			);
		} finally {
			setBusy(false);
		}
	};

	const unlink = async () => {
		setBusy(true);
		try {
			await desktopLink.unlink();
			// Hand the permission back too. Severing the link should return what the link needed,
			// rather than leaving a browser that can still talk to local programs for a feature it
			// is no longer using. Best-effort: failing to give it back must not fail the unlink,
			// which has already happened.
			await desktopLink.permission?.drop().catch(() => {});
			setConfirmUnlink(false);
			await refresh();
		} finally {
			setBusy(false);
		}
	};

	/**
	 * Build this browser's own copy of the desktop's vault from the claimed invite.
	 *
	 * The password is the shared master password: it proves this is the same person and wraps the
	 * local copy, so the browser keeps working when the app is closed.
	 */
	const acceptInvite = async () => {
		if (!invite) return;
		setJoining(true);
		setInviteError(null);
		// Captured BEFORE the join, while this vault is still the open one. Its entries are already
		// decrypted in memory here, which is what makes moving them possible at all: the two vaults
		// have different keys and only one is ever loaded, so the plaintext crossing between them
		// has to be held over the switch rather than re-wrapped in place.
		const carry = alsoMove ? entries.map(({ id: _id, ...data }) => data) : null;
		try {
			// Named, so a vault that appears in the list is recognisably the desktop's rather than
			// an unexplained "Vault 2".
			await startJoin(invite, { kind: "password", password: invitePassword }, t`Desktop vault`);
			setInvite(null);
			setInvitePassword("");
			setJoinSas(null);
			setOutcome(null);
			// After the join, so this lands in the vault that is now open. Failing here leaves the
			// originals untouched in the vault they came from, which is the safe way round.
			if (carry?.length) await importEntries(carry);
			setAlsoMove(false);
		} catch (e) {
			setInviteError(
				e instanceof Error && e.message ? e.message : t`Could not sync with the desktop app.`,
			);
		} finally {
			setJoining(false);
		}
	};

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
								: sharesThisVault === false
									? t`Linked to this browser, but the app shares a different vault, not this one.`
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
						{confirmUnlink ? (
							<span className="inline-flex items-center gap-2">
								<Button
									variant="destructiveOutline"
									size="sm"
									disabled={busy}
									onClick={() => void unlink()}
								>
									<Trans>Stop using the app</Trans>
								</Button>
								<Button variant="secondary" size="sm" onClick={() => setConfirmUnlink(false)}>
									<Trans>Cancel</Trans>
								</Button>
							</span>
						) : (
							<Button
								variant="ghost"
								size="sm"
								disabled={busy}
								onClick={() => setConfirmUnlink(true)}
							>
								<Trans>Disconnect</Trans>
							</Button>
						)}
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
			) : (
				<div className="space-y-3">
					<p className="text-sm text-muted-foreground">
						<Trans>
							Open Bramble on this computer, go to Settings and choose Connect a browser, then enter
							the code it shows.
						</Trans>
					</p>
					<TextField
						label={t`Pairing code`}
						value={code}
						autoComplete="off"
						spellCheck={false}
						// The alphabet is uppercase; the app folds case anyway, but showing it the
						// way it is displayed avoids a mismatch the user cannot see.
						onChange={(e) => setCode(e.target.value.toUpperCase().trim())}
						onKeyDown={(e) => {
							if (e.key === "Enter" && code.length === CODE_LENGTH) void pair();
						}}
						className="font-mono tracking-widest"
					/>
					<Button
						variant="primary"
						fullWidth
						disabled={busy || code.length !== CODE_LENGTH}
						onClick={() => void pair()}
					>
						<Trans>Connect</Trans>
					</Button>
				</div>
			)}

			{error && <p className="text-xs text-destructive">{error}</p>}
			<Modal
				open={invite !== null}
				onClose={() => {
					setInvite(null);
					setInvitePassword("");
					setOutcome(null);
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
						) : outcome === "add" ? (
							<Trans>Add the desktop's vault</Trans>
						) : (
							<Trans>Sync with the desktop app</Trans>
						)}
					</h2>
					{joinSas ? (
						<>
							<p className="text-xs text-muted-foreground">
								<Trans>
									The desktop app is showing the same symbols and waiting for you to approve there.
									Approve only if they match.
								</Trans>
							</p>
							<SasDisplay digits={joinSas.sas} emoji={joinSas.sasEmoji} />
						</>
					) : outcome === "switch" ? (
						// Nothing transfers and no vault is created: this browser is already in that
						// group. All that changes is which vault is open, so say that and ask, rather
						// than moving the user and leaving them to work out where they landed.
						<p className="text-xs text-muted-foreground">
							<Trans>
								This browser already shares that vault with the desktop app. Opening it just
								switches you to it; the vault you are in now stays exactly as it is.
							</Trans>
						</p>
					) : (
						<>
							<p className="text-xs text-muted-foreground">
								{outcome === "add" ? (
									<Trans>
										This adds the desktop's vault to this browser as a separate one. Your existing
										vaults stay as they are: two vaults cannot be combined automatically, because
										each is encrypted with its own key.
									</Trans>
								) : (
									<Trans>
										The desktop app offered to share its vault with this browser. Enter the master
										password you use there, then compare the symbols both screens show.
									</Trans>
								)}
							</p>
							<PasswordField
								label={t`Master password`}
								value={invitePassword}
								autoFocus
								onChange={(e) => {
									setInvitePassword(e.target.value);
									setInviteError(null);
								}}
							/>
							{outcome === "add" && entries.length > 0 && (
								<label className="flex items-start gap-2 text-xs text-muted-foreground">
									<input
										type="checkbox"
										className="mt-0.5"
										checked={alsoMove}
										onChange={(e) => setAlsoMove(e.target.checked)}
									/>
									<span>
										<Trans>
											Also copy this vault's {entries.length} entries into it, so everything is in
											one place. They stay here too; nothing is deleted.
										</Trans>
									</span>
								</label>
							)}
						</>
					)}
					{inviteError && <p className="text-xs text-destructive">{inviteError}</p>}
					<div className="flex justify-end gap-2">
						<Button
							variant="secondary"
							size="sm"
							onClick={() => {
								setInvite(null);
								setInvitePassword("");
							}}
						>
							{/* The link stays: declining the vault copy is not declining delegation. */}
							<Trans>Not now</Trans>
						</Button>
						<Button
							type="submit"
							size="sm"
							disabled={joining || (outcome !== "switch" && !invitePassword)}
						>
							{joining ? (
								<Trans>Waiting for the desktop app…</Trans>
							) : outcome === "switch" ? (
								<Trans>Open that vault</Trans>
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
