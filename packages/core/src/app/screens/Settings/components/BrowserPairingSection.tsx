import { Trans, useLingui } from "@lingui/react/macro";
import { Chrome, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { PairedBrowser } from "../../../../adapters/pairing";
import { usePlatform } from "../../../../context/PlatformContext";
import { formatDate } from "../../../../util/format-date";
import { Button } from "../../../components/ui/button";
import { Row, Section } from "./primitives";

/** Matches the code's server-side lifetime; shown as a countdown so an expired code on screen
 * cannot be mistaken for one that still works. */
const CODE_TTL_SECONDS = 180;

/** Pair this app with a browser extension. Rendered only where the platform provides a
 * pairing adapter, which today is desktop. See docs/desktop-port.md. */
export function BrowserPairingSection() {
	const { pairing } = usePlatform();
	const { t } = useLingui();
	const [browsers, setBrowsers] = useState<PairedBrowser[]>([]);
	const [code, setCode] = useState<string | null>(null);
	const [remaining, setRemaining] = useState(0);
	const [error, setError] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		if (!pairing) return;
		try {
			setBrowsers(await pairing.list());
			// Checked here and nowhere else. Listing browsers does not touch the credential
			// store, so without this a device whose key has gone missing shows a perfectly
			// normal list of browsers that can never connect again.
			await pairing.identity();
			setError(null);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, [pairing]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	// Count the code down and drop it when it expires. Without this the screen would keep
	// showing a secret the app has already stopped accepting, and the user would type it and
	// be told, with no explanation, that pairing failed.
	useEffect(() => {
		if (code === null) return;
		const tick = setInterval(() => {
			setRemaining((seconds) => {
				if (seconds <= 1) {
					setCode(null);
					return 0;
				}
				return seconds - 1;
			});
		}, 1000);
		return () => clearInterval(tick);
	}, [code]);

	// A code outlives the screen it is shown on unless something closes it. Leaving the
	// section (or the window) has to burn it, or it stays usable while nobody is looking.
	useEffect(() => {
		return () => {
			void pairing?.cancel();
		};
	}, [pairing]);

	if (!pairing) return null;

	const start = async () => {
		setError(null);
		try {
			setCode(await pairing.begin());
			setRemaining(CODE_TTL_SECONDS);
		} catch (e) {
			setError(String(e));
		}
	};

	const stop = async () => {
		setCode(null);
		setRemaining(0);
		await pairing.cancel();
		// A pairing may have completed while the code was up.
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

	const minutes = Math.floor(remaining / 60);
	const seconds = String(remaining % 60).padStart(2, "0");

	return (
		<Section icon={<Chrome className="w-4 h-4" />} title={t`Browser extension`}>
			{code === null ? (
				<>
					<Row
						icon={<Chrome className="w-4 h-4 text-primary" />}
						title={t`Connect a browser`}
						subtitle={t`Fill logins from the Bramble extension without unlocking twice.`}
					>
						<Button variant="secondary" size="sm" onClick={() => void start()}>
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
									<Button
										variant="ghost"
										size="sm"
										aria-label={t`Disconnect this browser`}
										onClick={() => void forget(browser.publicKey)}
									>
										<Trash2 className="w-4 h-4" />
									</Button>
								</div>
							))}
						</div>
					)}
				</>
			) : (
				<div className="space-y-3 text-center">
					<p className="text-sm text-muted-foreground">
						<Trans>Enter this code in the Bramble browser extension.</Trans>
					</p>
					{/* Spaced and monospaced because it is read off this screen and typed into
					    another; the alphabet already excludes characters that look alike. */}
					<p className="text-3xl font-mono tracking-[0.3em] select-all" data-selectable>
						{code}
					</p>
					<p className="text-xs text-muted-foreground">
						<Trans>
							Expires in {minutes}:{seconds}. It can only be used once.
						</Trans>
					</p>
					<Button variant="secondary" size="sm" onClick={() => void stop()}>
						<Trans>Cancel</Trans>
					</Button>
				</div>
			)}

			{error && <p className="text-xs text-destructive">{error}</p>}
		</Section>
	);
}
