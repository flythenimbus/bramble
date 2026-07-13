import { Trans, useLingui } from "@lingui/react/macro";
import { Bitcoin, Check, Coins, Copy, Heart, type LucideIcon } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useState } from "react";
import { usePlatform } from "../../../../context/PlatformContext";
import { Section } from "./primitives";

interface Wallet {
	name: string; // brand name, not localized
	ticker: string;
	/** Shown + copied: the human-readable value a donor pastes into their wallet. */
	address: string;
	/** QR payload (a payment URI). May differ from `address`: for Lightning it's the
	 * `lightning:LNURL…` (most universally scannable), while the copyable address stays
	 * the human `you@domain`; for Monero it's `monero:<addr>`. */
	qr: string;
	Icon: LucideIcon;
	accent: string;
}

// Donation wallets. Addresses are the app owner's. An entry with an unconfigured address is
// hidden, and the whole Support section disappears if none are set, so a placeholder is never
// shown or donated to. The Lightning QR encodes the LNURL for flythenimbus@cake.cash (verified
// live); regenerate it if the address changes.
const WALLETS: Wallet[] = [
	{
		name: "Bitcoin",
		ticker: "Lightning",
		address: "flythenimbus@cake.cash",
		qr: "lightning:LNURL1DP68GURN8GHJ7CMPDDJJUCMPWD5Z7TNHV4KXCTTTDEHHWM30D3H82UNVWQHKVMREW35X2MNFD4382UCG2WCEJ",
		Icon: Bitcoin,
		accent: "text-orange-500",
	},
	{
		name: "Monero",
		ticker: "XMR",
		address:
			"4AC3txuTwFm4fkamoYeK47c9EpnPwbreHNxJeKDYHiDNN6weD5vVA4BCH1azQhSxa6JjereuVpt21Pu2MyRDFDNNH6KGnWq",
		qr: "monero:4AC3txuTwFm4fkamoYeK47c9EpnPwbreHNxJeKDYHiDNN6weD5vVA4BCH1azQhSxa6JjereuVpt21Pu2MyRDFDNNH6KGnWq",
		Icon: Coins,
		accent: "text-orange-600",
	},
];

const isConfigured = (address: string) => !address.startsWith("REPLACE_WITH_");

/** One coin: QR (scan to pay), the full address, and a copy button that doesn't auto-clear. */
function WalletCard({ wallet }: { wallet: Wallet }) {
	const { clipboard } = usePlatform();
	const [copied, setCopied] = useState(false);
	const Icon = wallet.Icon;

	const copy = async () => {
		await (clipboard.copyPlain ?? clipboard.copy)(wallet.address);
		setCopied(true);
		setTimeout(() => setCopied(false), 1500);
	};

	return (
		<div className="flex flex-col items-center gap-3 rounded-lg border border-border p-3">
			<div className="flex items-center gap-2 self-start">
				<Icon className={`w-4 h-4 ${wallet.accent}`} />
				<span className="text-sm font-medium">{wallet.name}</span>
				<span className="text-xs text-muted-foreground">{wallet.ticker}</span>
			</div>
			{/* White quiet-zone so the QR scans against the dark theme; scales to the column. */}
			<div className="w-full max-w-[150px] rounded-lg bg-white p-2">
				<QRCodeSVG value={wallet.qr} size={132} marginSize={0} className="h-auto w-full" />
			</div>
			<p className="break-all text-center font-mono text-[11px] text-muted-foreground">
				{wallet.address}
			</p>
			<button
				type="button"
				onClick={() => void copy()}
				className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs transition-all hover:border-primary/50 hover:bg-primary/5 active:scale-[0.98]"
			>
				{copied ? (
					<>
						<Check className="w-3.5 h-3.5 text-emerald-500" />
						<Trans>Copied</Trans>
					</>
				) : (
					<>
						<Copy className="w-3.5 h-3.5" />
						<Trans>Copy address</Trans>
					</>
				)}
			</button>
		</div>
	);
}

/** About tab: optional donations panel. Hidden entirely until a wallet address is configured. */
export function SupportSection() {
	const { t } = useLingui();
	const wallets = WALLETS.filter((w) => isConfigured(w.address));
	if (wallets.length === 0) return null;

	return (
		<Section icon={<Heart className="w-4 h-4 text-primary" />} title={t`Support`}>
			<p className="text-sm text-muted-foreground">
				<Trans>
					Bramble is free and open source. If it's useful to you, a tip helps keep it going. Scan a
					code with your wallet, or copy the address. Thank you.
				</Trans>
			</p>
			<div className={`grid gap-3 ${wallets.length > 1 ? "grid-cols-2" : "mx-auto max-w-xs"}`}>
				{wallets.map((w) => (
					<WalletCard key={w.ticker} wallet={w} />
				))}
			</div>
		</Section>
	);
}
