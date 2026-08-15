import { Trans, useLingui } from "@lingui/react/macro";
import { Download, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { usePlatform } from "../../../../context/PlatformContext";
import { Button } from "../../../components/ui/button";
import { Row, Section } from "./primitives";

/**
 * Check for and install a new version of the app.
 *
 * Renders itself away where the host cannot update itself, which is everywhere but the desktop: a
 * store-distributed extension is updated by the store.
 *
 * Manual on purpose, for now. Downloading and applying a binary is the one thing here that should
 * not happen because a window happened to be open, and a background updater for a password manager
 * wants a settled answer on when it may restart the app.
 */
export function UpdatesSection() {
	const { shell } = usePlatform();
	const { t } = useLingui();
	const [state, setState] = useState<"idle" | "checking" | "installing">("idle");
	const [found, setFound] = useState<{ version: string; notes?: string } | null>(null);
	const [current, setCurrent] = useState(false);
	const [fraction, setFraction] = useState<number | null | undefined>(undefined);
	const [error, setError] = useState<string | null>(null);

	// Subscribed rather than tracked locally: the launch prompt can start a download, and this
	// section opened afterwards should show it rather than offering to check again.
	useEffect(() => shell.updates?.onProgress(setFraction), [shell]);

	// Nothing to offer, but not always nothing to say: where a package manager owns this install
	// the app cannot update itself and should not pretend otherwise, yet vanishing would read as
	// having no update story at all. Everywhere else (the extension, mobile) there is genuinely
	// nothing to report, because the store does it.
	if (!shell.updates) {
		if (!shell.updatesManagedExternally?.()) return null;
		return (
			<Section icon={<RefreshCw className="w-4 h-4 text-primary" />} title={t`Updates`}>
				<p className="text-sm text-muted-foreground">
					<Trans>
						This copy of Bramble is kept up to date by your system's package manager. Updating your
						system updates Bramble with it.
					</Trans>
				</p>
			</Section>
		);
	}

	// A download is running, whoever started it. The launch prompt sends people here mid-download,
	// so without this the section would sit on "Check for updates" while the app downloaded itself.
	const downloading = state === "installing" || fraction !== undefined;

	const look = async () => {
		setError(null);
		setCurrent(false);
		setState("checking");
		try {
			const update = await shell.updates?.check();
			setFound(update ?? null);
			setCurrent(!update);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setState("idle");
		}
	};

	const install = async () => {
		setError(null);
		setState("installing");
		try {
			// Does not return when it succeeds: the app relaunches into the new version.
			await shell.updates?.install();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			setState("idle");
		}
	};

	return (
		<Section icon={<RefreshCw className="w-4 h-4" />} title={t`Updates`}>
			<Row
				icon={<Download className="w-4 h-4 text-primary" />}
				title={
					found
						? t`Version ${found.version} is available`
						: downloading
							? t`Downloading the update`
							: t`Check for updates`
				}
				subtitle={
					downloading
						? t`Bramble restarts by itself once this finishes.`
						: found
							? t`Downloads and restarts Bramble. Your vault is untouched.`
							: current
								? t`Bramble is up to date.`
								: t`Bramble is installed directly, so updates are checked here.`
				}
			>
				{downloading ? (
					<Button variant="secondary" size="sm" disabled>
						{/* A percentage where the server gave a length, a plain label where it did not,
						    rather than a bar that would sit at zero and look stuck. */}
						{typeof fraction === "number" ? (
							<Trans>Downloading {Math.round(fraction * 100)}%</Trans>
						) : (
							<Trans>Downloading…</Trans>
						)}
					</Button>
				) : found ? (
					<Button
						variant="secondary"
						size="sm"
						disabled={state !== "idle"}
						onClick={() => void install()}
					>
						<Trans>Update and restart</Trans>
					</Button>
				) : (
					<Button
						variant="secondary"
						size="sm"
						disabled={state !== "idle"}
						onClick={() => void look()}
					>
						{state === "checking" ? <Trans>Checking…</Trans> : <Trans>Check</Trans>}
					</Button>
				)}
			</Row>
			{found?.notes && (
				<p className="text-xs text-muted-foreground whitespace-pre-line">{found.notes}</p>
			)}
			{error && (
				<p className="text-xs text-destructive">
					{/* Verbatim: "signature verification failed" and "no internet" want different
					    reactions from the user, and a single friendly line would hide which it was. */}
					<Trans>Update failed: {error}</Trans>
				</p>
			)}
		</Section>
	);
}
