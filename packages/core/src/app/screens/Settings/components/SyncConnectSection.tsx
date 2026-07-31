import { i18n } from "@lingui/core";
import { Trans, useLingui } from "@lingui/react/macro";
import { ChevronDown, ChevronRight, Plus, Trash2, Unplug, Wifi, X } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCan, usePlatform } from "../../../../context/PlatformContext";
import { usePendingEnrollApproval } from "../../../../hooks/usePendingEnrollApproval";
import { useVault, useVaultActions } from "../../../../hooks/useVault";
import { useVaultRegistry } from "../../../../hooks/useVaultRegistry";
import {
	activeDevices,
	decodePairingCode,
	type RosterEntry,
	type RosterPayload,
	SYNC_LAST_SYNCED_KEY,
} from "../../../../sync";
import { deriveIceUrl } from "../../../../sync/transport/ice";
import { formatDate } from "../../../../util/format-date";
import { Button } from "../../../components/ui/button";
import { Modal } from "../../../components/ui/modal";
import { PasswordField } from "../../../components/ui/password-field";
import { TextField } from "../../../components/ui/text-field";
import { Row, Section } from "./primitives";

const inputClass =
	"w-full px-3 py-1.5 text-xs font-mono rounded-lg border border-border bg-transparent focus:outline-none focus:border-primary/50";
const DEFAULT_RELAY = "wss://bramble-relay.flythenimbus.workers.dev";

interface SyncGroup {
	groupKey: string;
	roster: RosterPayload;
}

const fingerprint = (publicKey: string): string => publicKey.replace(/[^a-z0-9]/gi, "").slice(0, 6);
const addedOn = (ms: number): string => formatDate(ms);

/** m:ss for the invite countdown. */
const mmss = (seconds: number): string =>
	`${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

// Locale-aware relative time ("just now" / "5 minutes ago" / "2 days ago") via Intl, so
// "Last synced" reads at a glance. Coarsens by magnitude; refreshes on the next re-render.
const relativeTime = (ms: number): string => {
	const rtf = new Intl.RelativeTimeFormat(i18n.locale || "en", { numeric: "auto" });
	const sec = Math.round((ms - Date.now()) / 1000); // negative = in the past
	const abs = Math.abs(sec);
	// Coarsen sub-minute to a stable "now": while both devices are connected they reconcile
	// every few seconds, so second-precision would flicker "now" / "2 seconds ago".
	if (abs < 60) return rtf.format(0, "second");
	if (abs < 3600) return rtf.format(Math.round(sec / 60), "minute");
	if (abs < 86_400) return rtf.format(Math.round(sec / 3600), "hour");
	return rtf.format(Math.round(sec / 86_400), "day");
};

/**
 * Device sync panel. State-aware: before you're in a group it offers "add a device"
 * and "join from a code"; once enrolled it shows the synced devices + a disconnect
 * (leave the group, go offline-only) and per-device remove. See docs/p2p-sync.md.
 */
export function SyncConnectSection() {
	const { shell, storage } = usePlatform();
	const { inviteDevice, removeDevice, verifyMasterPassword } = useVaultActions();
	const { hasPasswordSlot } = useVault();
	const { syncKey } = useVaultRegistry();
	const canPerVaultSync = useCan("perVaultSync");
	const { t } = useLingui();
	// The panel is active-vault-scoped on every platform: refreshGroup, inviteDevice, and the
	// background sync-manager all read/write this vault's namespaced `sync.group`, so the devices,
	// invite, and disconnect shown here all act on the active vault (single-active on mobile, one of
	// several on the extension). See docs/multiple-vaults.md.
	// Hosted relay by default; overridable under Advanced. Loaded from storage below.
	const [relayUrl, setRelayUrl] = useState(DEFAULT_RELAY);
	const [iceUrl, setIceUrl] = useState(() => deriveIceUrl(DEFAULT_RELAY));
	const [advancedOpen, setAdvancedOpen] = useState(false);
	const [pairingCode, setPairingCode] = useState<string | null>(null);
	// Seconds left on the open invite. Cosmetic: the host enforces the window with its own timer.
	const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
	// The last gate before the vault leaves this device: until it is answered the joiner is
	// authenticated but has been sent nothing. The hook converges on the host, not one event.
	const [approval, setApproval] = usePendingEnrollApproval(shell, pairingCode !== null);
	/** The host closed the window. Independent of the countdown, which only runs while mounted. */
	const [hostExpired, setHostExpired] = useState(false);
	/** A join attempt killed the invite. Replaces the code: a dead QR just gets scanned again. */
	const [inviteError, setInviteError] = useState<string | null>(null);
	const [confirmDisconnect, setConfirmDisconnect] = useState(false);
	const [removingId, setRemovingId] = useState<string | null>(null);
	// Master-password gate before adding a device: the re-entered password admission-signs the new
	// device (Item A). Open only for a password vault; a security-key-only vault skips it (no password
	// to derive an admission key from, so the joiner is enrolled unsigned). See docs/p2p-sync-revocation-hardening.md.
	const [pwGateOpen, setPwGateOpen] = useState(false);
	const [gatePassword, setGatePassword] = useState("");
	const [gateError, setGateError] = useState<string | null>(null);
	const [gateBusy, setGateBusy] = useState(false);
	const [log, setLog] = useState<string[]>([]);
	const logRef = useRef<HTMLDivElement>(null);

	// Group membership (source of truth for "are we paired, and with whom"). undefined
	// while loading so we don't flash the onboarding UI over an existing group.
	const [group, setGroup] = useState<SyncGroup | null | undefined>(undefined);
	const [myPub, setMyPub] = useState<string | null>(null);
	// Epoch ms of the last successful reconcile with a peer (null = never / not loaded).
	const [lastSynced, setLastSynced] = useState<number | null>(null);

	const refreshGroup = useCallback(async () => {
		const [g, pub] = await Promise.all([
			storage.getMeta<SyncGroup>(syncKey("sync.group")),
			shell.syncDevicePublicKey().catch(() => null),
		]);
		setGroup(g ?? null);
		setMyPub(pub);
	}, [storage, syncKey, shell]);

	useEffect(() => {
		void refreshGroup();
	}, [refreshGroup]);

	// Reflect the relays this device actually uses (default, or adopted at enrollment).
	useEffect(() => {
		void (async () => {
			const [r, i] = await Promise.all([
				storage.getMeta<string>("sync.relay"),
				storage.getMeta<string>("sync.iceUrl"),
			]);
			if (r) setRelayUrl(r);
			// Show the stored endpoint, else the one derived from the relay (never blank).
			setIceUrl(i || deriveIceUrl(r || DEFAULT_RELAY));
		})();
	}, [storage]);

	// Persist on edit so the choice survives and ongoing sync + Settings pick it up.
	const onRelayChange = (v: string) => {
		setRelayUrl(v);
		void storage.setMeta("sync.relay", v);
	};
	const onIceChange = (v: string) => {
		setIceUrl(v);
		void storage.setMeta("sync.iceUrl", v);
	};

	// Read through a ref so the subscription doesn't depend on refreshGroup's identity, which
	// changes whenever the registry re-reads: re-subscribing drops events landing in the gap.
	const refreshGroupRef = useRef(refreshGroup);
	refreshGroupRef.current = refreshGroup;

	// A device finishing enrollment (inviter side) or this device joining changes the roster.
	// "synced" carries the last-synced tick on mobile (in-process); the extension uses subscribeMeta.
	useEffect(() => {
		const off = shell.onSyncEvent((e) => {
			if (e.kind === "enrolled" || e.kind === "joined" || e.kind === "roster")
				void refreshGroupRef.current();
			if (e.kind === "synced") setLastSynced(e.at ?? Date.now());
			// The host is the authority on expiry, not the countdown: this panel may not have been
			// mounted for it (an extension popup closes on focus loss).
			if (e.kind === "enroll-expired") setHostExpired(true);
			if (e.kind === "enroll-failed") setInviteError(e.message || null);
		});
		return off;
	}, [shell]);

	// "Last synced": read the persisted stamp on mount, and on the extension live-refresh via
	// storage change events (the background writes it). No-op subscription on mobile, where the
	// onSyncEvent "synced" tick above carries updates instead.
	useEffect(() => {
		const key = syncKey(SYNC_LAST_SYNCED_KEY);
		const read = () => void storage.getMeta<number>(key).then((v) => setLastSynced(v ?? null));
		read();
		return storage.subscribeMeta?.(key, read);
	}, [storage, syncKey]);

	// Stream transport status into the log for the panel's lifetime so enrollment
	// progress shows on both sides. The inviter's connection happens after its pairing
	// modal is dismissed, so a modal- or action-scoped subscription would miss it.
	useEffect(() => shell.onSyncStatus((s) => setLog((prev) => [...prev, s])), [shell]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll to newest on each line
	useEffect(() => {
		logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
	}, [log]);

	// TODO(i18n): note()/run() labels and ✅ messages below feed the hidden debug log
	// (its render is commented out), so they're left untranslated for now.
	const note = (line: string) => setLog((prev) => [...prev, line]);
	// Status streaming is a panel-lifetime subscription (below); here we just reset the
	// log to the action's label and surface a thrown failure.
	const run = async (label: string, fn: () => Promise<void>) => {
		setLog([label]);
		try {
			await fn();
		} catch (e) {
			note(`error: ${(e as Error).message}`);
		}
	};

	// The open invite's deadline, read back off the code we just handed the user.
	const inviteExp = useMemo(() => {
		if (pairingCode === null) return null;
		try {
			return decodePairingCode(pairingCode).exp ?? null;
		} catch {
			return null;
		}
	}, [pairingCode]);

	useEffect(() => {
		if (inviteExp === null) {
			setSecondsLeft(null);
			return;
		}
		const tick = () => setSecondsLeft(Math.max(0, Math.ceil((inviteExp - Date.now()) / 1000)));
		tick();
		const id = setInterval(tick, 1000);
		return () => clearInterval(id);
	}, [inviteExp]);

	// Either signal: the countdown is the smooth one, the host event is the reliable one.
	const inviteExpired = secondsLeft === 0 || hostExpired;

	// Withdraw a prompt left over past expiry: the session is gone, so approving it would do
	// nothing. Refusing also settles the host's parked promise.
	useEffect(() => {
		if (!inviteExpired || !approval) return;
		setApproval(null);
		void shell.approveEnrollment?.(false);
	}, [inviteExpired, approval, shell, setApproval]);

	// Dismissing the UI must stop the host listening too. Not stopSyncSpike, which would also drop
	// this device's ongoing sync.
	const closeInvite = useCallback(() => {
		setPairingCode(null);
		setApproval(null);
		void shell.stopEnrollInvite?.();
	}, [shell, setApproval]);

	// Answering spends the invite either way, so the UI just closes; retrying means reopening
	// "Add a device", which mints a fresh code.
	const answerApproval = useCallback(
		(approved: boolean) => {
			setApproval(null);
			// Not closeInvite(): that stops the host, and on approval the transfer is in flight.
			setPairingCode(null);
			void shell.approveEnrollment?.(approved);
		},
		[shell, setApproval],
	);

	const devices = group ? activeDevices(group.roster) : [];
	const others = myPub ? devices.filter((d) => d.publicKey !== myPub) : devices;
	const inGroup = group != null;
	const paired = others.length > 0;
	// "This device" first, then most-recently-added.
	const sortedDevices = [...devices].sort((a, b) =>
		a.publicKey === myPub ? -1 : b.publicKey === myPub ? 1 : b.addedAt - a.addedAt,
	);

	const addDevice = (password?: string) =>
		run("creating pairing code…", async () => {
			// A fresh invite; clear the previous one's expiry/failure.
			setHostExpired(false);
			setInviteError(null);
			setPairingCode(await inviteDevice(relayUrl.trim(), iceUrl.trim() || undefined, password));
			await refreshGroup();
		});
	// "Add device" entry point: a password vault confirms the master password first (it admission-signs
	// the joiner); a security-key-only vault has no password to re-enter, so it enrolls directly.
	const beginAddDevice = () => {
		if (!hasPasswordSlot) return void addDevice();
		setGatePassword("");
		setGateError(null);
		setPwGateOpen(true);
	};
	const confirmGate = async () => {
		setGateBusy(true);
		setGateError(null);
		try {
			if (!(await verifyMasterPassword(gatePassword))) {
				setGateError(t`Incorrect master password`);
				return;
			}
			const password = gatePassword;
			setPwGateOpen(false);
			setGatePassword("");
			await addDevice(password);
		} finally {
			setGateBusy(false);
		}
	};
	const remove = async (d: RosterEntry) => {
		setRemovingId(null);
		try {
			await removeDevice(d.id); // roster tombstone; ongoing sync propagates it
			await refreshGroup();
		} catch (e) {
			note(`error: ${(e as Error).message}`);
		}
	};
	const disconnect = () =>
		run("disconnecting…", async () => {
			setConfirmDisconnect(false);
			await shell.stopSyncSpike(); // halt enrollment + ongoing sync on this host
			// Remove THIS vault's group (namespaced), matching what refreshGroup + the sync engine
			// read; removing the flat "sync.group" left the namespaced key so the panel stayed "Synced".
			await storage.removeMeta(syncKey("sync.group")); // leave the group: nothing to resume
			await refreshGroup();
			note("✅ Disconnected — this device is now offline-only.");
		});

	return (
		<Section icon={<Wifi className="w-4 h-4 text-primary" />} title={t`Device sync`}>
			{/* Live transport status log (offer sent / answer applied / ice connected /
			    channel open) — surfaces enrollment + sync diagnostics in the dev panel. */}
			{log.length > 0 && (
				<div
					ref={logRef}
					className="max-h-40 overflow-y-auto rounded-lg border border-border bg-background/50 p-2 text-xs font-mono space-y-0.5"
				>
					{log.map((line, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: append-only status log
						<div key={i} className="text-muted-foreground break-words">
							{line}
						</div>
					))}
				</div>
			)}

			{/* Paired / in-a-group: show the synced devices + disconnect. */}
			{inGroup ? (
				<>
					<div className="flex items-center gap-2">
						<span
							className={`inline-block w-2 h-2 rounded-full ${paired ? "bg-emerald-500" : "bg-amber-500"}`}
							aria-hidden
						/>
						<span className="text-sm font-medium">
							{paired ? (
								<Trans>Synced · {devices.length} devices</Trans>
							) : (
								<Trans>Waiting for a device to join…</Trans>
							)}
						</span>
					</div>

					{lastSynced && (
						<p className="-mt-2 text-xs text-muted-foreground">
							<Trans>Last synced {relativeTime(lastSynced)}</Trans>
						</p>
					)}

					<div className="rounded-lg border border-border divide-y divide-border/60">
						{sortedDevices.map((d: RosterEntry) => (
							<div key={d.publicKey} className="flex items-center justify-between gap-2 px-3 py-2">
								<div className="min-w-0">
									<div className="text-sm truncate flex items-center gap-2">
										{d.label || t`Unnamed device`}
										{d.publicKey === myPub && (
											<span className="text-[10px] uppercase tracking-wide text-primary/80 border border-primary/40 rounded px-1 py-px">
												<Trans>This device</Trans>
											</span>
										)}
									</div>
									<div className="text-xs text-muted-foreground font-mono">
										<Trans>
											{fingerprint(d.publicKey)} · added {addedOn(d.addedAt)}
										</Trans>
									</div>
								</div>
								{d.publicKey !== myPub &&
									(removingId === d.id ? (
										<span className="flex shrink-0 items-center gap-2">
											<button
												type="button"
												onClick={() => void remove(d)}
												className="text-xs text-red-500 hover:underline"
											>
												<Trans>Remove</Trans>
											</button>
											<button
												type="button"
												onClick={() => setRemovingId(null)}
												className="text-xs text-muted-foreground hover:underline"
											>
												<Trans>Cancel</Trans>
											</button>
										</span>
									) : (
										<Button
											variant="link"
											size="none"
											onClick={() => setRemovingId(d.id)}
											aria-label={t`Remove ${d.label || "device"}`}
											className="shrink-0 p-1 hover:text-red-500 transition-colors"
										>
											<Trash2 className="w-4 h-4" />
										</Button>
									))}
							</div>
						))}
					</div>

					{!paired && (
						<p className="text-xs text-muted-foreground">
							<Trans>Open Bramble on your other device and scan the code, or paste it there.</Trans>
						</p>
					)}

					<div className="flex flex-wrap items-center gap-2">
						<Button variant="secondary" size="sm" onClick={beginAddDevice} className="gap-1.5">
							<Plus className="w-3.5 h-3.5" /> <Trans>Add another device</Trans>
						</Button>
						{confirmDisconnect ? (
							<span className="inline-flex items-center gap-2">
								<Button variant="destructiveOutline" size="sm" onClick={() => void disconnect()}>
									<Trans>Confirm disconnect</Trans>
								</Button>
								<Button variant="secondary" size="sm" onClick={() => setConfirmDisconnect(false)}>
									<Trans>Cancel</Trans>
								</Button>
							</span>
						) : (
							<Button
								variant="secondary"
								size="sm"
								onClick={() => setConfirmDisconnect(true)}
								className="gap-1.5 text-muted-foreground"
							>
								<Unplug className="w-3.5 h-3.5" /> <Trans>Disconnect</Trans>
							</Button>
						)}
					</div>
					{confirmDisconnect && (
						<p className="text-xs text-muted-foreground">
							<Trans>
								Stops syncing this device and keeps it offline-only. Your entries stay here; your
								other devices aren't affected.
							</Trans>
						</p>
					)}
				</>
			) : (
				// Not in a group yet: onboarding (create a group, or join an existing one).
				<>
					<Row
						icon={<Wifi className="w-4 h-4 text-primary" />}
						title={t`Add a device`}
						subtitle={t`Generate a one-time pairing code and listen for a device to join. No vault secrets in the code.`}
					>
						<Button variant="secondary" size="sm" onClick={beginAddDevice}>
							<Trans>Add a device</Trans>
						</Button>
					</Row>

					{/* Joining another group when a vault already exists means adding a parallel vault,
					    which only per-vault-sync hosts (the extension) support; on single-active mobile
					    the join path is the first-run setup, so don't point there from here. */}
					{canPerVaultSync && (
						<p className="ml-12 text-xs text-muted-foreground">
							<Trans>
								Have a pairing code from another device? Add a vault and choose "Join a device" to
								sync its vault onto this one. Once enrolled, devices sync automatically in the
								background while unlocked, no button or window needed.
							</Trans>
						</p>
					)}
				</>
			)}

			<Modal
				open={pwGateOpen}
				onClose={() => {
					setPwGateOpen(false);
					setGatePassword("");
				}}
				className="max-w-sm"
			>
				<form
					className="p-5 space-y-4"
					onSubmit={(e) => {
						e.preventDefault();
						void confirmGate();
					}}
				>
					<h2 className="text-base font-medium">
						<Trans>Confirm it's you</Trans>
					</h2>
					<p className="text-xs text-muted-foreground">
						<Trans>
							Enter your master password to authorize the new device. This proves the request came
							from you, not just a device that was already unlocked.
						</Trans>
					</p>
					<PasswordField
						label={t`Master password`}
						value={gatePassword}
						autoFocus
						onChange={(e) => {
							setGatePassword(e.target.value);
							setGateError(null);
						}}
						error={gateError ?? undefined}
					/>
					<div className="flex justify-end gap-2">
						<Button
							variant="secondary"
							size="sm"
							onClick={() => {
								setPwGateOpen(false);
								setGatePassword("");
							}}
						>
							<Trans>Cancel</Trans>
						</Button>
						<Button
							type="submit"
							variant="secondary"
							size="sm"
							disabled={!gatePassword || gateBusy}
						>
							<Trans>Continue</Trans>
						</Button>
					</div>
				</form>
			</Modal>

			<Modal
				open={pairingCode !== null}
				onClose={closeInvite}
				backdropClassName="bg-black/90"
				className="max-w-lg"
			>
				{pairingCode !== null && (
					<div className="p-5 space-y-4">
						<div className="flex items-center justify-between">
							<h2 className="text-base font-medium">
								<Trans>Add a device</Trans>
							</h2>
							<Button
								variant="link"
								size="none"
								onClick={closeInvite}
								aria-label={t`Close`}
								className="transition-colors"
							>
								<X className="w-4 h-4" />
							</Button>
						</div>
						{inviteError !== null ? (
							// A device tried and it didn't work. The invite is spent, so the code must go: a
							// QR that can no longer pair is worse than none, because it just gets scanned again.
							<>
								<p className="text-sm">
									<Trans>Pairing didn't complete.</Trans>
								</p>
								<p className="text-xs text-muted-foreground">{inviteError}</p>
								<Button
									variant="secondary"
									size="sm"
									onClick={() => {
										setPairingCode(null);
										beginAddDevice();
									}}
								>
									<Trans>Generate a new code</Trans>
								</Button>
							</>
						) : inviteExpired ? (
							// Expired: hide the code outright rather than leaving a dead one on screen to be
							// photographed. The invite is already dead on the host side (its own timer).
							<>
								<p className="text-sm">
									<Trans>This code has expired.</Trans>
								</p>
								<p className="text-xs text-muted-foreground">
									<Trans>
										Codes are short-lived on purpose. Generate a new one when your other device is
										ready to scan it.
									</Trans>
								</p>
								<Button
									variant="secondary"
									size="sm"
									onClick={() => {
										setPairingCode(null);
										beginAddDevice();
									}}
								>
									<Trans>Generate a new code</Trans>
								</Button>
							</>
						) : (
							<>
								<p className="text-xs text-muted-foreground">
									<Trans>
										Scan this on your other device, or copy the code below. Keep it private: anyone
										who sees it while this window is open could try to join. You'll confirm a
										matching number on both devices before anything is sent.
									</Trans>
								</p>
								<div className="rounded-xl bg-white p-4">
									<QRCodeSVG
										value={pairingCode}
										size={320}
										marginSize={2}
										className="h-auto w-full"
									/>
								</div>
								<div className="flex gap-2">
									<input
										readOnly
										value={pairingCode}
										onFocus={(e) => e.currentTarget.select()}
										className={`${inputClass} flex-1`}
									/>
									<Button
										variant="secondary"
										size="sm"
										onClick={() => void navigator.clipboard?.writeText(pairingCode)}
									>
										<Trans>Copy</Trans>
									</Button>
								</div>
								{secondsLeft !== null && (
									<p className="text-xs text-muted-foreground text-center">
										<Trans>
											Expires in {mmss(secondsLeft)} · keep this window open until pairing finishes
										</Trans>
									</p>
								)}
							</>
						)}
					</div>
				)}
			</Modal>

			{/* The approval gate. Stacked over the pairing modal, since the QR is still up when the
			    joiner arrives. Not dismissable by backdrop: an accidental click must not be able to
			    answer for the user, and closing it IS a refusal (the host treats it as one). */}
			<Modal open={approval !== null} onClose={() => answerApproval(false)} className="max-w-md">
				{approval !== null && (
					<div className="p-5 space-y-4">
						<h2 className="text-base font-medium">
							<Trans>Is this your device?</Trans>
						</h2>
						<p className="text-xs text-muted-foreground">
							<Trans>
								A device has connected with your pairing code. Check that it is showing this exact
								number, then approve. Your vault has not been sent yet.
							</Trans>
						</p>
						<p className="text-center font-mono text-3xl tracking-[0.2em] tabular-nums">
							{approval.sas}
						</p>
						{approval.label && (
							// The label is chosen by whoever is joining, so it is context, not evidence. Said
							// plainly here rather than left to be read as confirmation.
							<p className="text-center text-xs text-muted-foreground">
								<Trans>
									It calls itself "{approval.label}". Only the number above proves who it is.
								</Trans>
							</p>
						)}
						<div className="flex justify-end gap-2">
							<Button variant="destructiveOutline" size="sm" onClick={() => answerApproval(false)}>
								<Trans>Reject</Trans>
							</Button>
							<Button variant="secondary" size="sm" onClick={() => answerApproval(true)}>
								<Trans>Numbers match, approve</Trans>
							</Button>
						</div>
					</div>
				)}
			</Modal>

			<div>
				<Button
					variant="link"
					size="none"
					onClick={() => setAdvancedOpen((o) => !o)}
					className="gap-1.5 text-xs active:scale-[0.98]"
					aria-expanded={advancedOpen}
				>
					{advancedOpen ? (
						<ChevronDown className="w-3.5 h-3.5" />
					) : (
						<ChevronRight className="w-3.5 h-3.5" />
					)}
					<Trans>Advanced</Trans>
				</Button>
				{advancedOpen && (
					<div className="mt-3 space-y-5 pl-4 border-l border-border/40">
						<div className="space-y-1.5">
							<TextField
								label={t`Nostr relay URL`}
								value={relayUrl}
								onChange={(e) => onRelayChange(e.target.value)}
							/>
							<p className="text-xs text-muted-foreground">
								<Trans>
									The signaling relay that introduces devices. Defaults to the hosted relay; point
									it at your own or any public Nostr relay.
								</Trans>
							</p>
						</div>
						<div className="space-y-1.5">
							<TextField
								label={t`TURN / ICE servers URL`}
								value={iceUrl}
								onChange={(e) => onIceChange(e.target.value)}
							/>
							<p className="text-xs text-muted-foreground">
								<Trans>
									An endpoint that returns your own ICE servers as JSON. Defaults to the relay's.
								</Trans>
							</p>
						</div>
					</div>
				)}
			</div>
		</Section>
	);
}
