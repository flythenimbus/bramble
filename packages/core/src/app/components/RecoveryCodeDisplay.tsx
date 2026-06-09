import { Check, Copy, Download, TriangleAlert } from "lucide-react";
import { useState } from "react";

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
	title = "Save your recovery code",
	continueLabel = "I've saved it, continue",
	onContinue,
}: RecoveryCodeDisplayProps) {
	const [copied, setCopied] = useState(false);

	const copy = async () => {
		try {
			await navigator.clipboard.writeText(code);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {
			// Clipboard can be blocked; the code is still on screen to copy by hand.
		}
	};

	const download = () => {
		const body = [
			"Titanpass recovery code",
			"",
			code,
			"",
			"Keep this somewhere safe and offline. Anyone with this code can unlock",
			"your vault, and it's the only way back in if you forget your master",
			"password and lose your security keys.",
			"",
		].join("\n");
		const url = URL.createObjectURL(new Blob([body], { type: "text/plain" }));
		const a = document.createElement("a");
		a.href = url;
		a.download = "titanpass-recovery-code.txt";
		a.click();
		URL.revokeObjectURL(url);
	};

	return (
		<div className="space-y-5">
			<h2 className="text-xl text-center">{title}</h2>

			<div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-sm">
				<TriangleAlert className="w-4 h-4 mt-0.5 shrink-0 text-amber-500" />
				<span className="text-muted-foreground">
					<span className="font-medium text-foreground">
						You won't be able to see this code again.
					</span>{" "}
					Save it somewhere safe and offline now. It's the only way back in if you forget your
					master password and lose your security keys, and we can't recover it for you.
				</span>
			</div>

			<div className="rounded-lg border border-border/60 bg-background/60 px-4 py-6">
				<code className="block text-2xl sm:text-3xl font-bold font-mono tracking-widest text-center break-all select-all">
					{code}
				</code>
			</div>

			<div className="flex gap-2">
				<button
					type="button"
					onClick={copy}
					className="flex-1 px-4 py-2.5 text-sm rounded-lg border border-border hover:bg-primary/5 hover:border-primary/50 active:scale-[0.98] transition-all flex items-center justify-center gap-2"
				>
					{copied ? <Check className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />}
					{copied ? "Copied" : "Copy"}
				</button>
				<button
					type="button"
					onClick={download}
					className="flex-1 px-4 py-2.5 text-sm rounded-lg border border-border hover:bg-primary/5 hover:border-primary/50 active:scale-[0.98] transition-all flex items-center justify-center gap-2"
				>
					<Download className="w-4 h-4" />
					Download
				</button>
			</div>

			<button
				type="button"
				onClick={onContinue}
				className="w-full px-5 py-3 text-sm rounded-lg bg-primary text-primary-foreground border border-primary/20 hover:bg-primary/90 active:scale-[0.98] transition-all"
			>
				{continueLabel}
			</button>
		</div>
	);
}
