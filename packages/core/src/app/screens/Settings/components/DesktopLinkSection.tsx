import { Trans, useLingui } from "@lingui/react/macro";
import { CheckCircle2, Monitor } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { DesktopLinkStatus } from "../../../../adapters/desktop-link";
import { usePlatform } from "../../../../context/PlatformContext";
import { formatDate } from "../../../../util/format-date";
import { Button } from "../../../components/ui/button";
import { TextField } from "../../../components/ui/text-field";
import { Row, Section } from "./primitives";

/** Codes are 8 characters from an alphabet with no lookalikes; see the desktop app's
 * pairing.rs. Anything longer is a paste that picked up whitespace. */
const CODE_LENGTH = 8;

/** Link this browser to the Bramble desktop app. Rendered only where the platform provides a
 * desktop-link adapter, which today is the extension. See docs/desktop-port.md. */
export function DesktopLinkSection() {
	const { desktopLink } = usePlatform();
	const { t } = useLingui();
	const [status, setStatus] = useState<DesktopLinkStatus | null>(null);
	const [code, setCode] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [reachable, setReachable] = useState<boolean | null>(null);
	const [found, setFound] = useState<number | null>(null);
	const [probe, setProbe] = useState("github.com");

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

	if (!desktopLink) return null;

	const pair = async () => {
		setBusy(true);
		setError(null);
		try {
			await desktopLink.pair(code);
			setCode("");
			await refresh();
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

	// Asks a real question rather than just completing a handshake: the point of the link is
	// that vault data crosses it, so the check that proves it works should make that happen.
	const test = async () => {
		setBusy(true);
		setError(null);
		setReachable(null);
		try {
			const host = new URL(probe.startsWith("http") ? probe : `https://${probe}`).hostname;
			const matches = await desktopLink.query(host);
			setFound(matches.length);
			setReachable(true);
		} catch (e) {
			setReachable(false);
			setError(
				e instanceof Error && e.message === "locked"
					? t`Bramble is running but locked. Unlock it there first.`
					: e instanceof Error
						? e.message
						: String(e),
			);
		} finally {
			setBusy(false);
		}
	};

	const unlink = async () => {
		setBusy(true);
		try {
			await desktopLink.unlink();
			setReachable(null);
			await refresh();
		} finally {
			setBusy(false);
		}
	};

	return (
		<Section icon={<Monitor className="w-4 h-4" />} title={t`Desktop app`}>
			{status?.paired ? (
				<>
					<Row
						icon={<CheckCircle2 className="w-4 h-4 text-primary" />}
						title={t`Connected`}
						subtitle={
							status.pairedAt
								? t`Linked ${formatDate(status.pairedAt)}`
								: t`Linked to the Bramble desktop app.`
						}
					>
						<Button variant="secondary" size="sm" disabled={busy} onClick={() => void test()}>
							<Trans>Test</Trans>
						</Button>
					</Row>

					<div className="space-y-2">
						<TextField
							label={t`Look up a site`}
							value={probe}
							autoComplete="off"
							spellCheck={false}
							onChange={(e) => setProbe(e.target.value)}
						/>
						{reachable !== null && (
							<p className="text-xs text-muted-foreground">
								{reachable ? (
									<Trans>The desktop vault has {found} matching logins.</Trans>
								) : (
									<Trans>No answer. Is Bramble running on this computer?</Trans>
								)}
							</p>
						)}
					</div>

					<Button variant="ghost" size="sm" disabled={busy} onClick={() => void unlink()}>
						<Trans>Disconnect</Trans>
					</Button>
				</>
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
		</Section>
	);
}
