import { Trans, useLingui } from "@lingui/react/macro";
import { Check, Copy, Download, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { usePlatform } from "../../context/PlatformContext";
import { Button } from "./ui/button";

interface RecoveryCodeDisplayProps {
	code: string;
	title?: string;
	continueLabel?: string;
	onContinue: () => void;
}

/**
 * One-time recovery-code view (copy/download). Renders chrome-less so it drops
 * into onboarding or a Modal. The plaintext is never persisted: this is the only
 * chance to save it.
 */
export function RecoveryCodeDisplay({
	code,
	title,
	continueLabel,
	onContinue,
}: RecoveryCodeDisplayProps) {
	const { t } = useLingui();
	const { shell } = usePlatform();
	const appName = shell.appName;
	const [copied, setCopied] = useState(false);
	const titleText = title ?? t`Save your recovery code`;
	const continueText = continueLabel ?? t`I've saved it, continue`;

	const copy = async () => {
		try {
			await navigator.clipboard.writeText(code);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {
			// Clipboard can be blocked; the code is still on screen to copy by hand.
		}
	};

	const download = async () => {
		const body = [
			t`${appName} recovery code`,
			"",
			code,
			"",
			t`Keep this somewhere safe and offline. Anyone with this code can unlock your vault, and it's the only way back in if you forget your master password and lose your security keys.`,
			"",
		].join("\n");
		// Hardcoded rather than built from appName: a file name would need slugging, and this
		// matches the `.bramble` extension the rest of the app writes.
		const name = "bramble-recovery-code.txt";
		try {
			// On native platforms this saves via the OS share sheet ("Save to Files", Mail, ...);
			// a WKWebView ignores <a download>, so the blob path below is a web/extension fallback.
			if (shell.exportBytes) {
				await shell.exportBytes(name, new TextEncoder().encode(body), "text/plain");
				return;
			}
			const url = URL.createObjectURL(new Blob([body], { type: "text/plain" }));
			const a = document.createElement("a");
			a.href = url;
			a.download = name;
			a.click();
			URL.revokeObjectURL(url);
		} catch {
			// Save/share failed or was dismissed; the code is still on screen to copy by hand.
		}
	};

	return (
		<div className="space-y-5">
			<h2 className="text-xl text-center">{titleText}</h2>

			<div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-sm">
				<TriangleAlert className="w-4 h-4 mt-0.5 shrink-0 text-amber-500" />
				<span className="text-muted-foreground">
					<span className="font-medium text-foreground">
						<Trans>You won't be able to see this code again.</Trans>
					</span>{" "}
					<Trans>
						Save it somewhere safe and offline now. It's the only way back in if you forget your
						master password and lose your security keys, and we can't recover it for you.
					</Trans>
				</span>
			</div>

			<div className="rounded-lg border border-border/60 bg-background/60 px-4 py-6">
				<code className="block text-2xl sm:text-3xl font-bold font-mono tracking-widest text-center break-all select-all">
					{code}
				</code>
			</div>

			<div className="flex gap-2">
				<Button
					variant="secondary"
					size="none"
					onClick={copy}
					className="flex-1 px-4 py-2.5 text-sm"
				>
					{copied ? <Check className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />}
					{copied ? <Trans>Copied</Trans> : <Trans>Copy</Trans>}
				</Button>
				<Button
					variant="secondary"
					size="none"
					onClick={download}
					className="flex-1 px-4 py-2.5 text-sm"
				>
					<Download className="w-4 h-4" />
					<Trans>Download</Trans>
				</Button>
			</div>

			<Button variant="primary" size="lg" fullWidth onClick={onContinue} className="text-sm">
				{continueText}
			</Button>
		</div>
	);
}
