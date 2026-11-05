import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import { usePlatform } from "../../../../context/PlatformContext";
import type { LinkFrom } from "../../../../sync/link-outcome";
import { SasDisplay } from "../../../components/SasDisplay";
import { BackButton } from "../../../components/ui/back-button";
import { Button } from "../../../components/ui/button";
import { PasswordField } from "../../../components/ui/password-field";
import { TextField } from "../../../components/ui/text-field";
import { useDesktopLink } from "../../../hooks/useDesktopLink";

/** Codes are 8 characters; see the desktop app's pairing.rs. Only an older app uses one. */
const CODE_LENGTH = 8;

/**
 * Link the desktop app from the setup screen, so its vault becomes this browser's vault.
 * The same flow as Settings > Desktop app, through useDesktopLink. No pop-out: the setup screen
 * is a full tab that stays open while the user switches to the desktop app.
 */
export function DesktopLinkCard({
	from,
	onBack,
	onLinked,
}: {
	from: LinkFrom;
	onBack: () => void;
	/** The desktop's vault has arrived and opened. */
	onLinked?: () => void;
}) {
	const { desktopLink } = usePlatform();
	const { t } = useLingui();
	const link = useDesktopLink({ from });
	const [allowed, setAllowed] = useState<boolean | undefined>(undefined);
	const [password, setPassword] = useState("");

	useEffect(() => {
		void (async () => {
			setAllowed(desktopLink?.permission ? await desktopLink.permission.granted() : true);
		})();
	}, [desktopLink]);

	/** The grant reloads the page (see DesktopLinkSection); the URL brings the user back here. */
	const allow = async () => {
		if (!desktopLink?.permission) return;
		history.replaceState(null, "", "?setup=desktop");
		if (await desktopLink.permission.request().catch(() => false)) location.reload();
		else link.setError?.(t`Bramble needs that permission to talk to the desktop app.`);
	};

	let body: React.ReactNode;
	if (allowed === false) {
		body = (
			<>
				<p className="text-sm text-muted-foreground">
					<Trans>
						Bramble needs your permission to talk to the desktop app on this computer. Your browser
						will ask you to confirm.
					</Trans>
				</p>
				<Button fullWidth onClick={() => void allow()}>
					<Trans>Allow and continue</Trans>
				</Button>
			</>
		);
	} else if (link.linking) {
		body = (
			<div className="text-center space-y-3">
				<p className="text-sm">
					<Trans>Check these match your desktop app</Trans>
				</p>
				<SasDisplay digits={link.linking.sas.digits} emoji={link.linking.sas.emoji} large />
				{link.awaitingApp ? (
					<p className="text-sm text-muted-foreground">
						<Trans>Waiting for the desktop app…</Trans>
					</p>
				) : (
					<div className="flex justify-center gap-2">
						<Button
							variant="secondary"
							disabled={link.busy}
							onClick={() => void link.answer(false)}
						>
							<Trans>They don't match</Trans>
						</Button>
						<Button disabled={link.busy} onClick={() => void link.answer(true)}>
							<Trans>They match</Trans>
						</Button>
					</div>
				)}
			</div>
		);
	} else if (link.invite) {
		body = (
			<form
				className="space-y-3"
				onSubmit={(e) => {
					e.preventDefault();
					void link.accept(password).then((joined) => {
						if (joined) onLinked?.();
					});
				}}
			>
				<p className="text-sm text-muted-foreground">
					{link.summary ? (
						<Trans>
							Enter the master password of {link.summary.name}, the vault in your desktop app. This
							browser will use it too.
						</Trans>
					) : (
						<Trans>
							Enter the master password of the vault in your desktop app. This browser will use it
							too.
						</Trans>
					)}
				</p>
				<PasswordField
					label={t`Master password`}
					value={password}
					autoFocus
					onChange={(e) => setPassword(e.target.value)}
				/>
				{link.inviteError && <p className="text-xs text-destructive">{link.inviteError}</p>}
				<Button type="submit" fullWidth disabled={link.joining || !password}>
					<Trans>Link</Trans>
				</Button>
			</form>
		);
	} else if (link.legacy) {
		body = (
			<>
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
					onChange={(e) => link.setCode(e.target.value.toUpperCase().trim())}
					className="font-mono tracking-widest"
				/>
				<Button
					fullWidth
					disabled={link.busy || link.code.length !== CODE_LENGTH}
					onClick={() => void link.pairWithCode()}
				>
					<Trans>Connect</Trans>
				</Button>
			</>
		);
	} else {
		body = (
			<>
				<p className="text-sm text-muted-foreground">
					<Trans>
						Open Bramble on this computer, go to Settings and choose Connect a browser, then press
						Link. Both screens will show the same symbols.
					</Trans>
				</p>
				<Button fullWidth disabled={link.busy} onClick={() => void link.start()}>
					<Trans>Link</Trans>
				</Button>
			</>
		);
	}

	return (
		<div className="space-y-4 rounded-xl border border-border bg-card/50 p-5">
			<BackButton onClick={onBack} />
			{body}
			{link.error && <p className="text-xs text-destructive">{link.error}</p>}
		</div>
	);
}
