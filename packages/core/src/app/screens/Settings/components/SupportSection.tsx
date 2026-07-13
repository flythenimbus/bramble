import { Trans, useLingui } from "@lingui/react/macro";
import { Bitcoin, Check, Coins, Copy, Heart, type LucideIcon } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useState } from "react";
import { usePlatform } from "../../../../context/PlatformContext";
import { Section } from "./primitives";

interface Wallet {
	name: string; // brand name, not localized
	ticker: string;
	scheme: string; // URI scheme for the QR so wallets auto-fill (BIP-21 style)
	address: string;
	Icon: LucideIcon;
	accent: string;
}

// Donation wallets. Addresses are the app owner's; drop the real ones in (replacing the
// placeholders). A coin with an unconfigured address is hidden, and the whole Support
// section disappears if none are set, so a placeholder is never shown or donated to.
const WALLETS: Wallet[] = [
	{
		name: "Bitcoin",
		ticker: "BTC",
		scheme: "bitcoin",
		address: "REPLACE_WITH_BTC_ADDRESS",
		Icon: Bitcoin,
		accent: "text-orange-500",
	},
	{
		name: "Monero",
		ticker: "XMR",
		scheme: "monero",
		address: "REPLACE_WITH_XMR_ADDRESS",
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
		<div className="flex flex-col items-center gap-3 rounded-lg border border-border p-4">
			<div className="flex items-center gap-2 self-start">
				<Icon className={`w-4 h-4 ${wallet.accent}`} />
				<span className="text-sm font-medium">{wallet.name}</span>
				<span className="text-xs text-muted-foreground">{wallet.ticker}</span>
			</div>
			{/* White quiet-zone so the QR scans against the dark theme. */}
			<div className="rounded-lg bg-white p-2">
				<QRCodeSVG value={`${wallet.scheme}:${wallet.address}`} size={132} marginSize={0} />
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
			<div className="grid gap-3 sm:grid-cols-2">
				{wallets.map((w) => (
					<WalletCard key={w.ticker} wallet={w} />
				))}
			</div>
		</Section>
	);
}
