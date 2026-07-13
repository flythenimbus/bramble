import { Trans, useLingui } from "@lingui/react/macro";
import { Bitcoin, Check, Coins, Copy, Heart, type LucideIcon } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useState } from "react";
import { usePlatform } from "../../../../context/PlatformContext";
import { cn } from "../../../components/ui/utils";
import { Section } from "./primitives";

interface Method {
	label: string; // e.g. "Lightning" / "On-chain"; technical, not localized (like the coin names)
	/** Shown + copied: the human-readable value a donor pastes into their wallet. */
	address: string;
	/** QR payload (a payment URI). May differ from `address`: Lightning encodes the
	 * `lightning:LNURL…` (most universally scannable) while the copyable address stays the
	 * human `you@domain`; Monero/on-chain BTC use the `monero:`/`bitcoin:` URIs. */
	qr: string;
}

interface Wallet {
	name: string; // brand name, not localized
	ticker?: string;
	/** One payment method, or several with a toggle (e.g. BTC: Lightning + on-chain). */
	methods: Method[];
	Icon: LucideIcon;
	accent: string;
}

// Donation wallets. Addresses are the app owner's. A method with an unconfigured address is
// dropped, a wallet with no configured method is hidden, and the whole Support section
// disappears if none remain, so a placeholder is never shown or donated to. The Lightning QR
// encodes the LNURL for flythenimbus@cake.cash (verified live); regenerate it if it changes.
const WALLETS: Wallet[] = [
	{
		name: "Monero",
		ticker: "XMR",
		Icon: Coins,
		accent: "text-orange-600",
		methods: [
			{
				label: "Monero",
				address:
					"4AC3txuTwFm4fkamoYeK47c9EpnPwbreHNxJeKDYHiDNN6weD5vVA4BCH1azQhSxa6JjereuVpt21Pu2MyRDFDNNH6KGnWq",
				qr: "monero:4AC3txuTwFm4fkamoYeK47c9EpnPwbreHNxJeKDYHiDNN6weD5vVA4BCH1azQhSxa6JjereuVpt21Pu2MyRDFDNNH6KGnWq",
			},
		],
	},
	{
		name: "Bitcoin",
		ticker: "BTC",
		Icon: Bitcoin,
		accent: "text-orange-500",
		methods: [
			{
				label: "Lightning",
				address: "flythenimbus@cake.cash",
				qr: "lightning:LNURL1DP68GURN8GHJ7CMPDDJJUCMPWD5Z7TNHV4KXCTTTDEHHWM30D3H82UNVWQHKVMREW35X2MNFD4382UCG2WCEJ",
			},
			{
				label: "On-chain",
				address: "bc1q78sd5rnuufqdtv9plp0p56hrq72c9unj8tec8t",
				qr: "bitcoin:bc1q78sd5rnuufqdtv9plp0p56hrq72c9unj8tec8t",
			},
		],
	},
];

const isConfigured = (address: string) => !address.startsWith("REPLACE_WITH_");

const toggleBtn = (active: boolean) =>
	cn(
		"rounded px-2.5 py-0.5 transition-colors",
		active ? "bg-primary/10 text-foreground" : "text-muted-foreground hover:text-foreground",
	);

/** One coin: an optional method toggle, a QR (scan to pay), the address, and a non-clearing copy. */
function WalletCard({ wallet }: { wallet: Wallet }) {
	const { clipboard } = usePlatform();
	const [copied, setCopied] = useState(false);
	const [selected, setSelected] = useState(0);
	const Icon = wallet.Icon;
	const method = wallet.methods[selected] ?? wallet.methods[0];
	if (!method) return null;

	const copy = async () => {
		await (clipboard.copyPlain ?? clipboard.copy)(method.address);
		setCopied(true);
		setTimeout(() => setCopied(false), 1500);
	};

	return (
		<div className="flex flex-col items-center gap-3 rounded-lg border border-border p-3">
			<div className="flex items-center gap-2 self-start">
				<Icon className={cn("w-4 h-4", wallet.accent)} />
				<span className="text-sm font-medium">{wallet.name}</span>
				{wallet.ticker && <span className="text-xs text-muted-foreground">{wallet.ticker}</span>}
			</div>

			{/* White quiet-zone so the QR scans against the dark theme; scales to the column. */}
			<div className="w-full max-w-[150px] rounded-lg bg-white p-2">
				<QRCodeSVG value={method.qr} size={132} marginSize={0} className="h-auto w-full" />
			</div>

			{wallet.methods.length > 1 && (
				<div className="flex rounded-md border border-border p-0.5 text-[11px]">
					{wallet.methods.map((m, i) => (
						<button
							key={m.label}
							type="button"
							onClick={() => {
								setSelected(i);
								setCopied(false);
							}}
							className={toggleBtn(i === selected)}
						>
							{m.label}
						</button>
					))}
				</div>
			)}
			<p className="break-all text-center font-mono text-[11px] text-muted-foreground">
				{method.address}
			</p>
			<button
				type="button"
				onClick={() => void copy()}
				className="mt-auto inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs transition-all hover:border-primary/50 hover:bg-primary/5 active:scale-[0.98]"
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
	const wallets = WALLETS.map((w) => ({
		...w,
		methods: w.methods.filter((m) => isConfigured(m.address)),
	})).filter((w) => w.methods.length > 0);
	if (wallets.length === 0) return null;

	return (
		<Section icon={<Heart className="w-4 h-4 text-primary" />} title={t`Support`}>
			<p className="text-sm text-muted-foreground">
				<Trans>
					Bramble is free and open source. If it's useful to you, a tip helps keep it going. Scan a
					code with your wallet, or copy the address. Thank you.
				</Trans>
			</p>
			<div className={cn("grid gap-3", wallets.length > 1 ? "grid-cols-2" : "mx-auto max-w-xs")}>
				{wallets.map((w) => (
					<WalletCard key={w.name} wallet={w} />
				))}
			</div>
		</Section>
	);
}
