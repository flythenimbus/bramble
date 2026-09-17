import { Trans, useLingui } from "@lingui/react/macro";
import { Info } from "lucide-react";
import { useRef } from "react";
import { usePlatform } from "../../../../context/PlatformContext";
import { Button } from "../../../components/ui/button";
import { openDevFlags } from "../../../dev-flags-open";
import { storeReviewUrl } from "../../../review-nudge";
import { Section } from "./primitives";

// Public repository. External-origin links open in a new tab on the extension and in the
// system browser on mobile (Capacitor's default for cross-origin links).
const GITHUB_URL = "https://github.com/flythenimbus/bramble";

const linkClass = "text-primary hover:underline";

// Taps on the version that open the dev flag panel, and how long the run may take. The panel's
// keyboard shortcut cannot be pressed on a phone, and the panel is the only way to arm a
// store-review ask or flip a gate on a build you did not compile. Seven deliberate taps is the
// long-standing convention for this and is not something anybody reaches by accident, which is the
// same property the shortcut was chosen for. See app/dev-flags-open.ts.
const DEV_TAPS = 7;
const DEV_TAP_WINDOW_MS = 3000;

/** About tab: app version and links to the source. */
export function AboutSection() {
	const { shell, target } = usePlatform();
	const { t } = useLingui();
	// Absent on a target with no public listing (the Android APK, the desktop download), where the
	// row would be a link to nowhere. On iOS this is the write-review URL rather than the OS
	// prompt, which Apple does not allow behind a button; see adapters/shell requestStoreReview.
	const reviewUrl = storeReviewUrl(target);

	// Refs, not state: a tap run must not re-render the panel it is trying to open.
	const taps = useRef(0);
	const lastTap = useRef(0);
	const onVersionTap = () => {
		const now = Date.now();
		// A pause resets the run, so idle taps days apart never accumulate into an opening.
		taps.current = now - lastTap.current > DEV_TAP_WINDOW_MS ? 1 : taps.current + 1;
		lastTap.current = now;
		if (taps.current < DEV_TAPS) return;
		taps.current = 0;
		openDevFlags();
	};

	return (
		<Section icon={<Info className="w-4 h-4 text-primary" />} title={t`About`}>
			<div className="flex items-center justify-between text-sm">
				<span className="text-muted-foreground">
					<Trans>Version</Trans>
				</span>
				{/* Styled as the plain text it was: a way in for whoever already knows about it, not an
				    affordance. No hover change and no cursor change, on purpose. */}
				<Button
					variant="link"
					size="none"
					onClick={onVersionTap}
					className="text-foreground hover:text-foreground cursor-default"
				>
					{shell.version}
				</Button>
			</div>
			<div className="flex items-center justify-between text-sm">
				<span className="text-muted-foreground">
					<Trans>Source code</Trans>
				</span>
				<span className="flex items-center gap-2">
					<a href={GITHUB_URL} target="_blank" rel="noreferrer noopener" className={linkClass}>
						GitHub
					</a>
				</span>
			</div>
			{reviewUrl && (
				<div className="flex items-center justify-between text-sm">
					<span className="text-muted-foreground">
						<Trans>Rate Bramble</Trans>
					</span>
					<span className="flex items-center gap-2">
						<a href={reviewUrl} target="_blank" rel="noreferrer noopener" className={linkClass}>
							<Trans>Leave a review</Trans>
						</a>
					</span>
				</div>
			)}
		</Section>
	);
}
