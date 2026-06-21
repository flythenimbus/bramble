import { ChevronDown, ChevronRight, Wifi, X } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useRef, useState } from "react";
import { usePlatform } from "../../../../context/PlatformContext";
import { useVault } from "../../../../hooks/useVault";
import { isWebauthnAvailable } from "../../../../vault/webauthn-ceremony";
import { Modal } from "../../../components/ui/modal";
import { TextField } from "../../../components/ui/text-field";
import { Row, Section } from "./primitives";

const inputClass =
	"w-full px-3 py-1.5 text-xs font-mono rounded-lg border border-border bg-transparent focus:outline-none focus:border-primary/50";
const btnClass =
	"px-3 py-1.5 text-xs rounded-lg border border-border hover:bg-primary/5 hover:border-primary/50 active:scale-[0.98] transition-all disabled:opacity-50";
const toggleClass = (active: boolean) =>
	`px-3 py-1.5 text-xs rounded-lg border transition-all ${
		active
			? "border-primary/50 bg-primary/10 text-foreground"
			: "border-border text-muted-foreground"
	}`;

/**
 * Device sync panel: add a device (pairing code + QR), join from a pairing code,
 * and grant file access for headless sync. Status streams into the log at the top.
 * See docs/p2p-sync.md.
 */
export function SyncConnectSection() {
	const { shell, storage } = usePlatform();
	const { inviteDevice, joinGroup } = useVault();
	// Hosted relay by default; overridable under Advanced (own/self-host or any public Nostr relay).
	const [relayUrl, setRelayUrl] = useState("wss://bramble-relay.flythenimbus.workers.dev");
	const [advancedOpen, setAdvancedOpen] = useState(false);
	const [pairingCode, setPairingCode] = useState<string | null>(null);
	const [joinCode, setJoinCode] = useState("");
	const [joinPassword, setJoinPassword] = useState("");
	const [joinMethod, setJoinMethod] = useState<"password" | "securityKey">("password");
	const [log, setLog] = useState<string[]>([]);
	const logRef = useRef<HTMLDivElement>(null);
	const canUseSecurityKey = isWebauthnAvailable();

	// Stream the offscreen sync host's status lines into the log.
	useEffect(() => shell.onSyncStatus((s) => setLog((prev) => [...prev.slice(-40), s])), [shell]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll to newest on each line
	useEffect(() => {
		logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
	}, [log]);

	const note = (line: string) => setLog((prev) => [...prev, line]);
	const run = async (label: string, fn: () => Promise<void>) => {
		setLog([label]);
		try {
			await fn();
		} catch (e) {
			note(`error: ${(e as Error).message}`);
		}
	};

	const addDevice = () =>
		run("creating pairing code…", async () => setPairingCode(await inviteDevice(relayUrl.trim())));
	const join = () =>
		run("joining…", async () => {
			await joinGroup(
				joinCode,
				joinMethod === "securityKey"
					? { kind: "securityKey" }
					: { kind: "password", password: joinPassword },
			);
			// joinGroup resolves once the vault bundle has transferred and been written;
			// the "relay disconnected" status before this is normal teardown, not failure.
			note("✅ Synced — your entries are now on this device.");
			setJoinCode("");
			setJoinPassword("");
		});
	// Camera scan of the inviter's pairing QR (mobile only).
	const scanForJoinCode = () =>
		run("scanning…", async () => {
			const code = await shell.scanQrFromActiveTab();
			if (code) setJoinCode(code);
			else note("no code scanned");
		});
	const grantAccess = () =>
		run("granting file access…", async () => {
			await storage.requestVaultAccess();
			note("file access granted ✅");
		});

	return (
		<Section icon={<Wifi className="w-4 h-4 text-primary" />} title="Device sync">
			{log.length > 0 && (
				<div
					ref={logRef}
					className="max-h-40 overflow-y-auto rounded-lg border border-border bg-background/50 p-2 text-xs font-mono space-y-0.5"
				>
					{log.map((line, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: append-only status log
						<div key={i} className="text-muted-foreground break-words">
							{line}
						</div>
					))}
				</div>
			)}

			<Row
				icon={<Wifi className="w-4 h-4 text-primary" />}
				title="Add a device"
				subtitle="Generate a one-time pairing code and listen for a device to join. No vault secrets in the code."
			>
				<button type="button" onClick={() => void addDevice()} className={btnClass}>
					Add a device
				</button>
			</Row>

			<Modal
				open={pairingCode !== null}
				onClose={() => setPairingCode(null)}
				backdropClassName="bg-black/90"
				className="max-w-lg"
			>
				{pairingCode !== null && (
					<div className="p-5 space-y-4">
						<div className="flex items-center justify-between">
							<h2 className="text-base font-medium">Add a device</h2>
							<button
								type="button"
								onClick={() => setPairingCode(null)}
								aria-label="Close"
								className="text-muted-foreground hover:text-foreground transition-colors"
							>
								<X className="w-4 h-4" />
							</button>
						</div>
						<p className="text-xs text-muted-foreground">
							Scan this on your other device, or copy the code below. No vault secrets are in it.
						</p>
						<div className="rounded-xl bg-white p-4">
							<QRCodeSVG value={pairingCode} size={320} marginSize={2} className="h-auto w-full" />
						</div>
						<div className="flex gap-2">
							<input
								readOnly
								value={pairingCode}
								onFocus={(e) => e.currentTarget.select()}
								className={`${inputClass} flex-1`}
							/>
							<button
								type="button"
								onClick={() => void navigator.clipboard?.writeText(pairingCode)}
								className={btnClass}
							>
								Copy
							</button>
						</div>
					</div>
				)}
			</Modal>

			<Row
				icon={<Wifi className="w-4 h-4 text-primary" />}
				title="Join with a pairing code"
				subtitle="Paste the code from your other device to sync this one to it. Replaces this profile's vault."
			>
				<button
					type="button"
					onClick={() => void join()}
					disabled={!joinCode.trim() || (joinMethod === "password" && !joinPassword)}
					className={btnClass}
				>
					Join
				</button>
			</Row>

			<div className="ml-12 mt-1 space-y-4">
				<TextField
					label="Pairing code"
					value={joinCode}
					onChange={(e) => setJoinCode(e.target.value)}
				/>
				{shell.supportsCameraScan && (
					<button type="button" onClick={() => void scanForJoinCode()} className={btnClass}>
						Scan QR code
					</button>
				)}
				<div className="space-y-4">
					{canUseSecurityKey && (
						<div className="flex gap-2">
							<button
								type="button"
								onClick={() => setJoinMethod("password")}
								className={toggleClass(joinMethod === "password")}
							>
								Master password
							</button>
							<button
								type="button"
								onClick={() => setJoinMethod("securityKey")}
								className={toggleClass(joinMethod === "securityKey")}
							>
								Security key
							</button>
						</div>
					)}
					{joinMethod === "password" ? (
						<TextField
							type="password"
							label="Master password for this device"
							value={joinPassword}
							onChange={(e) => setJoinPassword(e.target.value)}
						/>
					) : (
						<p className="text-xs text-muted-foreground">
							You'll tap your security key when you press Join. No master password is set on this
							device.
						</p>
					)}
				</div>
			</div>

			<Row
				icon={<Wifi className="w-4 h-4 text-primary" />}
				title="Grant file access"
				subtitle="For file-backed vaults, the background needs file permission to sync while closed. Grant it here (or enable persistent file access in your browser so it survives restarts)."
			>
				<button type="button" onClick={() => void grantAccess()} className={btnClass}>
					Grant access
				</button>
			</Row>

			<p className="ml-12 text-xs text-muted-foreground">
				Once enrolled, devices sync automatically in the background while unlocked, no button or
				window needed.
			</p>

			<div>
				<button
					type="button"
					onClick={() => setAdvancedOpen((o) => !o)}
					className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground active:scale-[0.98] transition-all"
					aria-expanded={advancedOpen}
				>
					{advancedOpen ? (
						<ChevronDown className="w-3.5 h-3.5" />
					) : (
						<ChevronRight className="w-3.5 h-3.5" />
					)}
					Advanced
				</button>
				{advancedOpen && (
					<div className="mt-3 space-y-1.5 pl-4 border-l border-border/40">
						<TextField
							label="Nostr relay URL"
							value={relayUrl}
							onChange={(e) => setRelayUrl(e.target.value)}
						/>
						<p className="text-xs text-muted-foreground">
							The signaling relay that introduces devices. Defaults to the hosted relay; point it at
							your own self-hosted copy or any public Nostr relay.
						</p>
					</div>
				)}
			</div>
		</Section>
	);
}
