import { Trans, useLingui } from "@lingui/react/macro";
import { ChevronDown, ChevronRight, Plus, Trash2, Unplug, Wifi, X } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePlatform } from "../../../../context/PlatformContext";
import { useVaultActions } from "../../../../hooks/useVault";
import { activeDevices, type RosterEntry, type RosterPayload } from "../../../../sync";
import { deriveIceUrl } from "../../../../sync/transport/ice";
import { isWebauthnAvailable } from "../../../../vault/webauthn-ceremony";
import { Modal } from "../../../components/ui/modal";
import { TextField } from "../../../components/ui/text-field";
import { Row, Section } from "./primitives";

const inputClass =
	"w-full px-3 py-1.5 text-xs font-mono rounded-lg border border-border bg-transparent focus:outline-none focus:border-primary/50";
const btnClass =
	"px-3 py-1.5 text-xs rounded-lg border border-border hover:bg-primary/5 hover:border-primary/50 active:scale-[0.98] transition-all disabled:opacity-50";
const toggleClass = (active: boolean) =>
	`px-3 py-1.5 text-xs rounded-lg border transition-all ${
		active
			? "border-primary/50 bg-primary/10 text-foreground"
			: "border-border text-muted-foreground"
	}`;

const DEFAULT_RELAY = "wss://bramble-relay.flythenimbus.workers.dev";

interface SyncGroup {
	groupKey: string;
	roster: RosterPayload;
}

const fingerprint = (publicKey: string): string => publicKey.replace(/[^a-z0-9]/gi, "").slice(0, 6);
const addedOn = (ms: number): string =>
	new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

/**
 * Device sync panel. State-aware: before you're in a group it offers "add a device"
 * and "join from a code"; once enrolled it shows the synced devices + a disconnect
 * (leave the group, go offline-only) and per-device remove. See docs/p2p-sync.md.
 */
export function SyncConnectSection() {
	const { shell, storage } = usePlatform();
	const { inviteDevice, joinGroup, removeDevice } = useVaultActions();
	const { t } = useLingui();
	// Hosted relay by default; overridable under Advanced. Loaded from storage below.
	const [relayUrl, setRelayUrl] = useState(DEFAULT_RELAY);
	const [iceUrl, setIceUrl] = useState(() => deriveIceUrl(DEFAULT_RELAY));
	const [advancedOpen, setAdvancedOpen] = useState(false);
	const [pairingCode, setPairingCode] = useState<string | null>(null);
	const [joinCode, setJoinCode] = useState("");
	const [joinPassword, setJoinPassword] = useState("");
	const [joinPasswordConfirm, setJoinPasswordConfirm] = useState("");
	// Join failure (e.g. password doesn't match the other device), shown as an inline
	// validation error under the password field. The debug status log is hidden, so
	// this is the only user-facing surface for a failed join.
	const [joinError, setJoinError] = useState<string | null>(null);
	const [joinMethod, setJoinMethod] = useState<"password" | "securityKey">("password");
	const [confirmDisconnect, setConfirmDisconnect] = useState(false);
	const [removingId, setRemovingId] = useState<string | null>(null);
	const [log, setLog] = useState<string[]>([]);
	const logRef = useRef<HTMLDivElement>(null);
	// Security-key pairing only where WebAuthn keys actually work: the extension.
	// Mobile webviews expose PublicKeyCredential but can't use security keys (no prf
	// on iOS, NFC-blocked on Android), so the join there is master-password only.
	const canUseSecurityKey = shell.supportsSecurityKeys && isWebauthnAvailable();

	// Group membership (source of truth for "are we paired, and with whom"). undefined
	// while loading so we don't flash the onboarding UI over an existing group.
	const [group, setGroup] = useState<SyncGroup | null | undefined>(undefined);
	const [myPub, setMyPub] = useState<string | null>(null);

	const refreshGroup = useCallback(async () => {
		const [g, pub] = await Promise.all([
			storage.getMeta<SyncGroup>("sync.group"),
			shell.syncDevicePublicKey().catch(() => null),
		]);
		setGroup(g ?? null);
		setMyPub(pub);
	}, [storage, shell]);

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

	// A device finishing enrollment (inviter side) or this device joining changes the roster.
	useEffect(
		() =>
			shell.onSyncEvent((e) => {
				if (e.kind === "enrolled" || e.kind === "joined" || e.kind === "roster")
					void refreshGroup();
			}),
		[shell, refreshGroup],
	);

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

	const devices = group ? activeDevices(group.roster) : [];
	const others = myPub ? devices.filter((d) => d.publicKey !== myPub) : devices;
	const inGroup = group != null;
	const paired = others.length > 0;
	// "This device" first, then most-recently-added.
	const sortedDevices = [...devices].sort((a, b) =>
		a.publicKey === myPub ? -1 : b.publicKey === myPub ? 1 : b.addedAt - a.addedAt,
	);

	const addDevice = () =>
		run("creating pairing code…", async () => {
			setPairingCode(await inviteDevice(relayUrl.trim(), iceUrl.trim() || undefined));
			await refreshGroup();
		});
	const join = () =>
		run("joining…", async () => {
			setJoinError(null);
			try {
				await joinGroup(
					joinCode,
					joinMethod === "securityKey"
						? { kind: "securityKey" }
						: { kind: "password", password: joinPassword },
				);
			} catch (e) {
				// Surface the reason (e.g. "doesn't match your other device") visibly, then
				// rethrow so run() still logs it to the hidden diagnostics.
				setJoinError((e as Error).message);
				throw e;
			}
			// joinGroup resolves once the vault bundle has transferred and been written;
			// the "relay disconnected" status before this is normal teardown, not failure.
			note("✅ Synced — your entries are now on this device.");
			setJoinCode("");
			setJoinPassword("");
			setJoinPasswordConfirm("");
			await refreshGroup();
		});
	// Camera scan of the inviter's pairing QR (mobile only).
	const scanForJoinCode = () =>
		run("scanning…", async () => {
			const code = await shell.scanQrFromActiveTab();
			if (code) setJoinCode(code);
			else note("no code scanned");
		});
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
			await storage.removeMeta("sync.group"); // leave the group: nothing to resume
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
										<button
											type="button"
											onClick={() => setRemovingId(d.id)}
											aria-label={t`Remove ${d.label || "device"}`}
											className="shrink-0 p-1 text-muted-foreground hover:text-red-500 transition-colors"
										>
											<Trash2 className="w-4 h-4" />
										</button>
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
						<button
							type="button"
							onClick={() => void addDevice()}
							className={`${btnClass} inline-flex items-center gap-1.5`}
						>
							<Plus className="w-3.5 h-3.5" /> <Trans>Add another device</Trans>
						</button>
						{confirmDisconnect ? (
							<span className="inline-flex items-center gap-2">
								<button
									type="button"
									onClick={() => void disconnect()}
									className="px-3 py-1.5 text-xs rounded-lg border border-red-500/50 text-red-500 hover:bg-red-500/10 active:scale-[0.98] transition-all"
								>
									<Trans>Confirm disconnect</Trans>
								</button>
								<button
									type="button"
									onClick={() => setConfirmDisconnect(false)}
									className={btnClass}
								>
									<Trans>Cancel</Trans>
								</button>
							</span>
						) : (
							<button
								type="button"
								onClick={() => setConfirmDisconnect(true)}
								className={`${btnClass} inline-flex items-center gap-1.5 text-muted-foreground`}
							>
								<Unplug className="w-3.5 h-3.5" /> <Trans>Disconnect</Trans>
							</button>
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
						<button type="button" onClick={() => void addDevice()} className={btnClass}>
							<Trans>Add a device</Trans>
						</button>
					</Row>

					<Row
						icon={<Wifi className="w-4 h-4 text-primary" />}
						title={t`Join with a pairing code`}
						subtitle={t`Paste the code from your other device to sync this one to it. Replaces this profile's vault.`}
					>
						<button
							type="button"
							onClick={() => void join()}
							disabled={
								!joinCode.trim() ||
								(joinMethod === "password" &&
									(!joinPassword || joinPassword !== joinPasswordConfirm))
							}
							className={btnClass}
						>
							<Trans>Join</Trans>
						</button>
					</Row>

					<div className="ml-12 mt-1 space-y-4">
						<TextField
							label={t`Pairing code`}
							value={joinCode}
							onChange={(e) => setJoinCode(e.target.value)}
						/>
						{shell.supportsCameraScan && (
							<button type="button" onClick={() => void scanForJoinCode()} className={btnClass}>
								<Trans>Scan QR code</Trans>
							</button>
						)}
						<div className="space-y-4">
							{canUseSecurityKey && (
								<div className="flex gap-2">
									<button
										type="button"
										onClick={() => setJoinMethod("password")}
										className={toggleClass(joinMethod === "password")}
									>
										<Trans>Master password</Trans>
									</button>
									<button
										type="button"
										onClick={() => setJoinMethod("securityKey")}
										className={toggleClass(joinMethod === "securityKey")}
									>
										<Trans>Security key</Trans>
									</button>
								</div>
							)}
							{joinMethod === "password" ? (
								<div className="space-y-4">
									<TextField
										type="password"
										label={t`Master password for this device`}
										value={joinPassword}
										onChange={(e) => {
											setJoinPassword(e.target.value);
											setJoinError(null);
										}}
										error={joinError ?? undefined}
									/>
									<TextField
										type="password"
										label={t`Confirm master password`}
										value={joinPasswordConfirm}
										onChange={(e) => setJoinPasswordConfirm(e.target.value)}
										error={
											joinPasswordConfirm.length > 0 && joinPassword !== joinPasswordConfirm
												? t`Passwords don't match`
												: undefined
										}
									/>
								</div>
							) : (
								<p className="text-xs text-muted-foreground">
									<Trans>
										You'll tap your security key when you press Join. No master password is set on
										this device.
									</Trans>
								</p>
							)}
						</div>
					</div>

					<p className="ml-12 text-xs text-muted-foreground">
						<Trans>
							Once enrolled, devices sync automatically in the background while unlocked, no button
							or window needed.
						</Trans>
					</p>
				</>
			)}

			<Modal
				open={pairingCode !== null}
				onClose={() => setPairingCode(null)}
				backdropClassName="bg-black/90"
				className="max-w-lg"
			>
				{pairingCode !== null && (
					<div className="p-5 space-y-4">
						<div className="flex items-center justify-between">
							<h2 className="text-base font-medium">
								<Trans>Add a device</Trans>
							</h2>
							<button
								type="button"
								onClick={() => setPairingCode(null)}
								aria-label={t`Close`}
								className="text-muted-foreground hover:text-foreground transition-colors"
							>
								<X className="w-4 h-4" />
							</button>
						</div>
						<p className="text-xs text-muted-foreground">
							<Trans>
								Scan this on your other device, or copy the code below. No vault secrets are in it.
							</Trans>
						</p>
						<div className="rounded-xl bg-white p-4">
							<QRCodeSVG value={pairingCode} size={320} marginSize={2} className="h-auto w-full" />
						</div>
						<div className="flex gap-2">
							<input
								readOnly
								value={pairingCode}
								onFocus={(e) => e.currentTarget.select()}
								className={`${inputClass} flex-1`}
							/>
							<button
								type="button"
								onClick={() => void navigator.clipboard?.writeText(pairingCode)}
								className={btnClass}
							>
								<Trans>Copy</Trans>
							</button>
						</div>
					</div>
				)}
			</Modal>

			<div>
				<button
					type="button"
					onClick={() => setAdvancedOpen((o) => !o)}
					className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground active:scale-[0.98] transition-all"
					aria-expanded={advancedOpen}
				>
					{advancedOpen ? (
						<ChevronDown className="w-3.5 h-3.5" />
					) : (
						<ChevronRight className="w-3.5 h-3.5" />
					)}
					<Trans>Advanced</Trans>
				</button>
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
