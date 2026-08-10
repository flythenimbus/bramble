import { Trans, useLingui } from "@lingui/react/macro";
import { Download, RefreshCw } from "lucide-react";
import { useState } from "react";
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
	const [fraction, setFraction] = useState<number | null>(null);
	const [error, setError] = useState<string | null>(null);

	if (!shell.updates) return null;

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
			await shell.updates?.install(setFraction);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			setState("idle");
		}
	};

	return (
		<Section icon={<RefreshCw className="w-4 h-4" />} title={t`Updates`}>
			<Row
				icon={<Download className="w-4 h-4 text-primary" />}
				title={found ? t`Version ${found.version} is available` : t`Check for updates`}
				subtitle={
					found
						? t`Downloads and restarts Bramble. Your vault is untouched.`
						: current
							? t`Bramble is up to date.`
							: t`Bramble is installed directly, so updates are checked here.`
				}
			>
				{found ? (
					<Button
						variant="secondary"
						size="sm"
						disabled={state !== "idle"}
						onClick={() => void install()}
					>
						{state === "installing" ? (
							// A percentage where the server gave a length, a plain label where it did not,
							// rather than a bar that would sit at zero and look stuck.
							fraction === null ? (
								<Trans>Downloading…</Trans>
							) : (
								<Trans>Downloading {Math.round(fraction * 100)}%</Trans>
							)
						) : (
							<Trans>Update and restart</Trans>
						)}
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
