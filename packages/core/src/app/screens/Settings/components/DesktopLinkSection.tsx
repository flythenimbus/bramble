import { Trans, useLingui } from "@lingui/react/macro";
import { CheckCircle2, Monitor } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { DesktopLinkStatus } from "../../../../adapters/desktop-link";
import { usePlatform } from "../../../../context/PlatformContext";
import { useVaultActions } from "../../../../hooks/useVault";
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
	const { desktopLink, shell } = usePlatform();
	const { t } = useLingui();
	const { startJoin } = useVaultActions();
	const [status, setStatus] = useState<DesktopLinkStatus | null>(null);
	const [code, setCode] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	/** The invite the app handed over, waiting on the master password that unlocks the copy. */
	const [invite, setInvite] = useState<string | null>(null);
	const [invitePassword, setInvitePassword] = useState("");
	const [inviteError, setInviteError] = useState<string | null>(null);
	const [joining, setJoining] = useState(false);
	/** The SAS for the join in flight. The inviter is holding on the user's answer, so without
	 * this the modal is a disabled button and the only way past it is approving something on the
	 * other screen that has not been compared with anything. */
	const [joinSas, setJoinSas] = useState<{ sas: string; sasEmoji?: number[] } | null>(null);

	const refresh = useCallback(async () => {
		if (!desktopLink) return;
		try {
			setStatus(await desktopLink.status());
		} catch (e) {
			setError(String(e));
		}
	}, [desktopLink]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

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
			setInvite(claimed);
		};
		void check();
		const id = setInterval(() => void check(), OFFER_POLL_MS);
		return () => {
			cancelled = true;
			clearInterval(id);
		};
	}, [desktopLink, status?.paired, invite]);

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
		try {
			await startJoin(invite, { kind: "password", password: invitePassword });
			setInvite(null);
			setInvitePassword("");
			setJoinSas(null);
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
			{status?.paired ? (
				<Row
					icon={<CheckCircle2 className="w-4 h-4 text-primary" />}
					title={t`Connected`}
					subtitle={
						status.pairedAt
							? t`Linked ${formatDate(status.pairedAt)}`
							: t`Linked to the Bramble desktop app.`
					}
				>
					{/* The only control left once Test went, so it takes the row's slot rather
					    than sitting under an otherwise empty one. */}
					<Button variant="ghost" size="sm" disabled={busy} onClick={() => void unlink()}>
						<Trans>Disconnect</Trans>
					</Button>
				</Row>
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
						<Trans>Sync with the desktop app</Trans>
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
					) : (
						<>
							<p className="text-xs text-muted-foreground">
								<Trans>
									The desktop app offered to share its vault with this browser. Enter the master
									password you use there, then compare the symbols both screens show.
								</Trans>
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
						<Button type="submit" size="sm" disabled={joining || !invitePassword}>
							{joining ? <Trans>Waiting for the desktop app…</Trans> : <Trans>Sync</Trans>}
						</Button>
					</div>
				</form>
			</Modal>
		</Section>
	);
}
