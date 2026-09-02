import { Trans, useLingui } from "@lingui/react/macro";
import { AlertTriangle, KeyRound, type LucideIcon, Plus, Search, ShieldCheck } from "lucide-react";
import type { QrScanFailure } from "../../../util/totp";
import { Button } from "../../components/ui/button";
import { TextField } from "../../components/ui/text-field";

/** One login the handed-over key could be saved against. */
export interface TotpTarget {
	id: string;
	name: string;
	secondary: string;
	icon: LucideIcon;
	initials?: string;
	/** This login already holds an authenticator key, so picking it replaces a working one. */
	hasTotp: boolean;
}

interface TotpSetupProps {
	/** Issuer and account parsed out of the key; both are blank for a bare setup key. */
	issuer: string;
	account: string;
	/** Existing logins, already filtered by `query` and sorted. */
	targets: TotpTarget[];
	query: string;
	onQueryChange: (q: string) => void;
	onCreateNew: () => void;
	onPick: (id: string) => void;
}

/**
 * Where should a handed-over authenticator key go? Shown when another app or a website
 * sends Bramble an `otpauth://` URI (iOS "Set Up Codes In", an Android `otpauth://`
 * intent). It never saves anything itself: both legs land on a form the user submits,
 * which is what keeps an entry point any app on the device can fire from writing to the
 * vault. See docs/totp-uri-handler.md.
 */
export function TotpSetup({
	issuer,
	account,
	targets,
	query,
	onQueryChange,
	onCreateNew,
	onPick,
}: TotpSetupProps) {
	const { t } = useLingui();
	// A bare setup key carries neither, so the header falls back to naming the kind of
	// thing that arrived rather than showing an empty line.
	const title = issuer || account || t`Authenticator key`;
	const subtitle = issuer && account ? account : "";

	return (
		<main className="flex-1 min-h-0 flex flex-col w-full max-w-5xl mx-auto px-4 py-5">
			<div className="mb-5 flex items-start gap-3">
				<div className="shrink-0 w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
					<ShieldCheck className="w-5 h-5 text-primary" />
				</div>
				<div className="min-w-0">
					<h2 className="text-base truncate">{title}</h2>
					{subtitle && <p className="text-sm text-muted-foreground truncate">{subtitle}</p>}
					<p className="text-sm text-muted-foreground mt-0.5">
						<Trans>Choose where to save this 2FA code.</Trans>
					</p>
				</div>
			</div>

			<Button
				variant="secondary"
				fullWidth
				onClick={onCreateNew}
				className="mb-5 flex items-center justify-center gap-2"
			>
				<Plus className="w-4 h-4" />
				<Trans>Save to a new login</Trans>
			</Button>

			<p className="mb-2 px-1 text-xs font-medium text-muted-foreground">
				<Trans>Or add it to an existing login</Trans>
			</p>

			<TextField
				label={t`Search logins`}
				type="search"
				value={query}
				onChange={(e) => onQueryChange(e.target.value)}
				startAdornment={<Search className="w-4 h-4" />}
				className="mb-3"
			/>

			<div className="flex-1 min-h-0 overflow-y-auto">
				{targets.length === 0 ? (
					<p className="py-8 text-center text-sm text-muted-foreground">
						<Trans>No logins match.</Trans>
					</p>
				) : (
					<ul className="space-y-1">
						{targets.map((target) => (
							<li key={target.id}>
								<button
									type="button"
									onClick={() => onPick(target.id)}
									className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border border-border/50 bg-card/50 text-left transition-colors hover:border-border hover:bg-card active:scale-[0.99]"
								>
									<span className="shrink-0 w-9 h-9 rounded-lg bg-muted flex items-center justify-center text-xs text-muted-foreground">
										{target.initials ?? <target.icon className="w-4 h-4" />}
									</span>
									<span className="min-w-0 flex-1">
										<span className="block truncate text-sm">{target.name}</span>
										<span className="block truncate text-xs text-muted-foreground">
											{target.secondary}
										</span>
									</span>
									{/* Named at the point of decision, not after: picking this login overwrites a
									    key that is presumably working, and the edit form would not say so. */}
									{target.hasTotp && (
										<span className="shrink-0 flex items-center gap-1 text-xs text-yellow-500">
											<AlertTriangle className="w-3.5 h-3.5" />
											<Trans>Replaces code</Trans>
										</span>
									)}
								</button>
							</li>
						))}
					</ul>
				)}
			</div>
		</main>
	);
}

/**
 * Why a handed-over URI can't become an authenticator key. Same four verdicts the QR
 * scanner classifies, but the way out differs: nothing was scanned here, an app sent us
 * something, so the scanner's "make the QR visible and retry" advice would be nonsense.
 */
export function TotpSetupFailure({
	failure,
	vendor,
	onDismiss,
}: {
	failure: QrScanFailure;
	vendor?: string;
	onDismiss: () => void;
}) {
	const { t } = useLingui();

	const explain = () => {
		switch (failure) {
			case "vendor-app":
				return t`That link sets up ${vendor ?? "another authenticator app"}, so it holds no key to save. On the site, choose to use a different authenticator app, then use the code it offers.`;
			case "migration":
				return t`That link is an authenticator export holding several accounts, not a setup code. Add each account from its own site instead.`;
			case "not-totp":
				return t`That link isn't an authenticator setup code Bramble can use. Counter-based (HOTP) codes aren't supported.`;
			default:
				return t`Nothing usable was handed over. Open the site's 2FA page and add the code from the login instead.`;
		}
	};

	return (
		<main className="flex-1 min-h-0 flex flex-col items-center justify-center w-full max-w-md mx-auto px-6 text-center">
			<div className="w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center mb-4">
				<KeyRound className="w-6 h-6 text-destructive" />
			</div>
			<h2 className="text-base mb-2">
				<Trans>Can't save this code</Trans>
			</h2>
			<p className="text-sm text-muted-foreground mb-6">{explain()}</p>
			<Button onClick={onDismiss}>
				<Trans>Back to vault</Trans>
			</Button>
		</main>
	);
}
