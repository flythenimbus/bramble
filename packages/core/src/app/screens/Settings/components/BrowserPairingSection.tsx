import { Trans, useLingui } from "@lingui/react/macro";
import { Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PairedBrowser } from "../../../../adapters/pairing";
import { usePlatform } from "../../../../context/PlatformContext";
import { UnrecognizedDeviceError } from "../../../../hooks/useSyncEnrollment";
import { useVault, useVaultActions } from "../../../../hooks/useVault";
import { useVaultRegistry } from "../../../../hooks/useVaultRegistry";
import { linkSas } from "../../../../sync/link-sas";
import type { PairingSas } from "../../../../sync/pairing-sas";
import { formatDate } from "../../../../util/format-date";
import { isVaultEmpty, readVaultContents } from "../../../../vault/vault-empty";
import { displayLabel } from "../../../../vault/vault-registry";
import { Puzzle } from "../../../components/icons/Puzzle";
import { SasDisplay } from "../../../components/SasDisplay";
import { Button } from "../../../components/ui/button";
import { InlineConfirm } from "../../../components/ui/inline-confirm";
import { Modal } from "../../../components/ui/modal";
import { PasswordField } from "../../../components/ui/password-field";
import { Row, Section } from "./primitives";

/** Matches the link window's lifetime in the app (pairing.rs `LINK_WINDOW`), after which a
 * browser pressing Link is refused, so the screen closes with it. */
const WINDOW_SECONDS = 180;

const DEFAULT_RELAY = "wss://bramble-relay.flythenimbus.workers.dev";

/** Pair this app with a browser extension. Rendered only where the platform provides a
 * pairing adapter, which today is desktop. See docs/desktop-port.md. */
export function BrowserPairingSection() {
	const { pairing, storage } = usePlatform();
	const { t } = useLingui();
	const { inviteDevice, verifyMasterPassword } = useVaultActions();
	const { hasPasswordSlot, entries, files } = useVault();
	const { vaults, activeId } = useVaultRegistry();
	const [browsers, setBrowsers] = useState<PairedBrowser[]>([]);
	/** The Connect dialog is open: a browser pressing Link now reaches this vault. */
	const [open, setOpen] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// The master-password gate. Connecting a browser now also enrols it in this vault's sync
	// group, and admitting a device is signed with a key derived from a freshly typed password.
	const [gateOpen, setGateOpen] = useState(false);
	const [gatePassword, setGatePassword] = useState("");
	const [gateError, setGateError] = useState<string | null>(null);
	const [gateBusy, setGateBusy] = useState(false);
	/** The browser that linked while the dialog was open, so the screen confirms rather than just
	 * counting down to nothing. */
	const [connected, setConnected] = useState<string | null>(null);
	/** Who was already linked when the dialog opened. In a ref because it is a snapshot of that
	 * moment: as state it would re-arm the watcher on every list change and lose the baseline. */
	const knownBefore = useRef<Set<string>>(new Set());
	/** A browser waiting on this screen's answer, with the emoji both screens show. */
	const [linkPending, setLinkPending] = useState<{ sas: PairingSas; label: string } | null>(null);
	/** This screen said yes; the link completes once the browser does too. */
	const [approved, setApproved] = useState(false);

	const refresh = useCallback(async () => {
		if (!pairing) return;
		try {
			setBrowsers(await pairing.list());
			// Checked here and nowhere else. Listing browsers never fails on a missing key, so
			// without this a device whose key has gone missing shows a perfectly normal list of
			// browsers that can never connect again.
			await pairing.identity();
			setError(null);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, [pairing]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	// Close the dialog when the app's link window closes. Without this the screen would keep
	// inviting the user to press Link in a browser the app will now refuse.
	useEffect(() => {
		if (!open) return;
		const timer = setTimeout(() => setOpen(false), WINDOW_SECONDS * 1000);
		return () => clearTimeout(timer);
	}, [open]);

	// A link completes on the app's own thread, so nothing here is told about it. While the dialog
	// is open, watch the list: a new browser means it worked, which is the only feedback this
	// screen can give and the difference between "done" and a window that silently expires.
	useEffect(() => {
		if (!open || !pairing) return;
		const id = setInterval(() => {
			void pairing.list().then((list) => {
				const fresh = list.find((b) => !knownBefore.current.has(b.publicKey));
				if (!fresh) return;
				setBrowsers(list);
				setConnected(fresh.label);
				setOpen(false);
			});
		}, 1500);
		return () => clearInterval(id);
	}, [open, pairing]);

	// The link window outlives the screen it is opened from unless something closes it. Leaving
	// the section (or the window) has to close it, or it stays open while nobody is looking. The
	// sync invite goes with it: a browser must not be able to claim the vault from a dialog the
	// user walked away from.
	useEffect(() => {
		return () => {
			void pairing?.cancelLinkWindow?.();
			void pairing?.setVaultSummary?.(null);
			void pairing?.clearSyncInvite?.();
		};
	}, [pairing]);

	// The browser's emoji, once its handshake is done. Rust holds it until both screens answer.
	useEffect(() => {
		if (!pairing?.onLinkPending || !pairing.onLinkDone) return;
		const offPending = pairing.onLinkPending(({ sasHashB64, label }) => {
			setApproved(false);
			void linkSas(sasHashB64).then((sas) => setLinkPending({ sas, label }));
		});
		const offDone = pairing.onLinkDone((paired) => {
			setLinkPending(null);
			setApproved(false);
			if (!paired) setError(t`The browser was not linked.`);
		});
		return () => {
			offPending();
			offDone();
		};
	}, [pairing, t]);

	if (!pairing) return null;

	/**
	 * One dialog for both halves: the link that lets the browser delegate, and the sync invite
	 * that gives it this vault.
	 *
	 * The invite is ARMED rather than sent. The browser claims it over the link once it has
	 * paired, and the app answers only while this window is open, so an old pairing cannot be
	 * used to take the vault later. `password` admission-signs the joiner. Resolves with what to
	 * show when the invite cannot be armed, and nothing is left open then.
	 */
	const start = async (password: string): Promise<string | null> => {
		setError(null);
		setConnected(null);
		knownBefore.current = new Set(browsers.map((b) => b.publicKey));
		try {
			await publishSummary();
			await pairing.beginLinkWindow?.();
			// "Press Link" shows once the invite is armed: a browser that linked sooner got the link
			// and never the vault.
			await armInvite(password);
			setOpen(true);
			return null;
		} catch (e) {
			// Nothing is left open: a link without the invite would be a pairing with no vault in the
			// browser. The caller shows this and offers Continue again.
			await pairing.cancelLinkWindow?.();
			await pairing.setVaultSummary?.(null);
			return e instanceof UnrecognizedDeviceError
				? t`This device can't add devices right now: your other devices no longer recognize it. Disconnect, then join again with a code from another device.`
				: e instanceof Error
					? e.message
					: String(e);
		}
	};

	/** The sync invite a linked browser claims, armed for as long as the dialog is open so the two
	 * windows cannot disagree. `password` admission-signs it. */
	const armInvite = async (password: string) => {
		if (!pairing.armSyncInvite) return; // link only: this platform cannot deliver an invite
		const relay = (await storage.getMeta<string>("sync.relay")) ?? DEFAULT_RELAY;
		const iceUrl = (await storage.getMeta<string>("sync.iceUrl")) ?? undefined;
		const invite = await inviteDevice(relay, iceUrl || undefined, password, { viaLink: true });
		await pairing.armSyncInvite(invite, WINDOW_SECONDS * 1000);
	};

	/** What this vault holds, for the browser deciding whether to take, combine or ask. */
	const publishSummary = async () => {
		if (!pairing.setVaultSummary || !activeId) return;
		const index = vaults.findIndex((v) => v.id === activeId);
		const contents = await readVaultContents(storage, activeId, entries.length, files.length);
		await pairing.setVaultSummary({
			name: displayLabel(vaults[index]?.label ?? "", Math.max(0, index)),
			empty: isVaultEmpty(contents),
			entries: entries.length,
		});
	};

	/** Confirm the master password first: it signs the admission. A vault without one may not pair. */
	const begin = () => {
		if (!hasPasswordSlot) {
			setError(
				t`Connecting a browser needs a master password. Turn one on in Settings → Security first.`,
			);
			return;
		}
		setGatePassword("");
		setGateError(null);
		setGateOpen(true);
	};

	const confirmGate = async () => {
		setGateBusy(true);
		setGateError(null);
		try {
			if (!(await verifyMasterPassword(gatePassword))) {
				setGateError(t`Incorrect master password`);
				return;
			}
			// Open, and busy, until the browser can be told to press Link. On a failure it stays,
			// with the password, so Continue tries again.
			const failed = await start(gatePassword);
			if (failed) {
				setGateError(failed);
				return;
			}
			setGateOpen(false);
			setGatePassword("");
		} finally {
			setGateBusy(false);
		}
	};

	const stop = async () => {
		setOpen(false);
		setLinkPending(null);
		setApproved(false);
		await pairing.cancelLinkWindow?.();
		await pairing.setVaultSummary?.(null);
		await pairing.clearSyncInvite?.();
		// A link may have completed while the dialog was open.
		await refresh();
	};

	const forget = async (publicKey: string) => {
		try {
			await pairing.forget(publicKey);
			await refresh();
		} catch (e) {
			setError(String(e));
		}
	};

	return (
		<Section icon={<Puzzle className="w-4 h-4" />} title={t`Browser extension`}>
			{connected !== null && (
				<p className="text-xs text-primary">
					<Trans>Connected to {connected}. It is syncing this vault and can fill from it.</Trans>
				</p>
			)}
			{!open ? (
				<>
					<Row
						icon={<Puzzle className="w-4 h-4 text-primary" />}
						title={t`Connect a browser`}
						subtitle={t`Sync this vault to the Bramble extension and fill from it without unlocking twice.`}
					>
						<Button variant="secondary" size="sm" onClick={begin}>
							<Trans>Connect</Trans>
						</Button>
					</Row>

					{browsers.length > 0 && (
						<div className="space-y-2">
							{browsers.map((browser) => (
								<div
									key={browser.publicKey}
									className="flex items-center justify-between gap-3 rounded-lg border border-border/50 px-3 py-2"
								>
									<div className="min-w-0">
										{/* Self-declared at pairing time, so it is shown as information and
										    never used to decide anything. */}
										<p className="text-sm truncate">{browser.label}</p>
										<p className="text-xs text-muted-foreground mt-0.5">
											<Trans>Connected {formatDate(browser.pairedAt)}</Trans>
										</p>
									</div>
									<InlineConfirm
										variant="destructiveOutline"
										confirmLabel={<Trans>Disconnect</Trans>}
										onConfirm={() => forget(browser.publicKey)}
										trigger={(arm) => (
											<Button
												variant="ghost"
												size="sm"
												aria-label={t`Disconnect this browser`}
												onClick={arm}
											>
												<Trash2 className="w-4 h-4" />
											</Button>
										)}
									/>
								</div>
							))}
						</div>
					)}
				</>
			) : linkPending ? (
				<div className="space-y-3 text-center">
					<p className="text-sm">
						<Trans>Check these match {linkPending.label}</Trans>
					</p>
					<SasDisplay digits={linkPending.sas.digits} emoji={linkPending.sas.emoji} large />
					{approved ? (
						// The link completes once the browser confirms too, whichever answers last.
						<p className="text-sm text-muted-foreground">
							<Trans>Waiting for {linkPending.label}…</Trans>
						</p>
					) : (
						<>
							<p className="text-xs text-muted-foreground">
								<Trans>Approve only if your browser shows the same symbols.</Trans>
							</p>
							<div className="flex justify-center gap-2">
								<Button
									variant="secondary"
									size="sm"
									onClick={() => void pairing.answerLink?.(false)}
								>
									<Trans>They don't match</Trans>
								</Button>
								<Button
									size="sm"
									onClick={() => {
										setApproved(true);
										void pairing.answerLink?.(true);
									}}
								>
									<Trans>Approve</Trans>
								</Button>
							</div>
						</>
					)}
				</div>
			) : (
				<div className="space-y-3 text-center">
					<p className="text-sm text-muted-foreground">
						<Trans>
							In the Bramble extension, press Link on the first screen, or open Settings → Desktop
							app. Both screens will then show the same symbols.
						</Trans>
					</p>
					<div>
						<Button variant="secondary" size="sm" onClick={() => void stop()}>
							<Trans>Cancel</Trans>
						</Button>
					</div>
				</div>
			)}

			{error && <p className="text-xs text-destructive">{error}</p>}
			<Modal
				open={gateOpen}
				onClose={() => {
					setGateOpen(false);
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
							Enter your master password to connect a browser. This vault is copied to it, so the
							request has to come from you and not just from a device that was already unlocked.
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
					/>
					{gateError && <p className="text-xs text-destructive">{gateError}</p>}
					<div className="flex justify-end gap-2">
						<Button
							variant="secondary"
							size="sm"
							onClick={() => {
								setGateOpen(false);
								setGatePassword("");
							}}
						>
							<Trans>Cancel</Trans>
						</Button>
						<Button type="submit" size="sm" disabled={gateBusy || !gatePassword}>
							<Trans>Continue</Trans>
						</Button>
					</div>
				</form>
			</Modal>
		</Section>
	);
}
