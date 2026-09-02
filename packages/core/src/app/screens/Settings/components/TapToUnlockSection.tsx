import { Trans, useLingui } from "@lingui/react/macro";
import { Fingerprint, KeyRound } from "lucide-react";
import { useCallback, useState } from "react";
import { useCan } from "../../../../context/PlatformContext";
import { useVault } from "../../../../hooks/useVault";
import type { WebauthnKeyKind } from "../../../../vault/webauthn-ceremony";
import { Button } from "../../../components/ui/button";
import { useWebauthnHandoff, type WebauthnHandoff } from "../../../hooks/useWebauthnHandoff";
import { Row } from "./primitives";

/**
 * Touch ID / Windows Hello and security keys in one list, because they are one mechanism: both
 * derive a KEK from the WebAuthn PRF extension and mint the same webauthn slot. Only the
 * registration ceremony differs, and incompatibly (see webauthn-ceremony.ts), which is why Add
 * asks which one rather than letting the OS dialog decide.
 *
 * Firefox shows the section but not the security-key option: it supports PRF for platform
 * authenticators only. See docs/security-keys.md.
 */
export function TapToUnlockSection() {
	const { webauthnKeys, registerWebauthnKey, revokeWebauthnKey } = useVault();
	const canSecurityKeys = useCan("securityKeys");
	const { t } = useLingui();
	const [adding, setAdding] = useState(false);
	const [label, setLabel] = useState("");
	const [busy, setBusy] = useState<WebauthnKeyKind | null>(null);
	const [error, setError] = useState<string | null>(null);

	const runRegister = useCallback(
		async (kind: WebauthnKeyKind, named: string) => {
			setError(null);
			setBusy(kind);
			try {
				await registerWebauthnKey(named, kind);
				setLabel("");
				setAdding(false);
			} catch (err) {
				setError(String(err instanceof Error ? err.message : err));
			} finally {
				setBusy(null);
			}
		},
		[registerWebauthnKey],
	);

	// Resume a registration the popup could not host (Firefox); no-op everywhere else. The name
	// travels with it so the user does not retype what they already entered.
	const onResume = useCallback(
		(intent: WebauthnHandoff) => {
			if (intent.webauthn !== "register") return;
			setAdding(true);
			setLabel(intent.label);
			void runRegister(intent.kind, intent.label);
		},
		[runRegister],
	);
	const { mustHandOff, handOff } = useWebauthnHandoff(onResume);

	const handleAdd = (kind: WebauthnKeyKind) => {
		const named = label.trim() || (kind === "platform" ? t`This device` : t`Security key`);
		if (mustHandOff) {
			handOff({ webauthn: "register", kind, label: named });
			return;
		}
		void runRegister(kind, named);
	};

	const handleRevoke = async (slotIdB64: string) => {
		setError(null);
		try {
			await revokeWebauthnKey(slotIdB64);
		} catch (err) {
			setError(String(err instanceof Error ? err.message : err));
		}
	};

	return (
		<>
			<Row
				icon={<Fingerprint className="w-4 h-4 text-primary" />}
				title={t`Tap to unlock`}
				subtitle={
					canSecurityKeys
						? t`Use Touch ID, Windows Hello or a security key like a YubiKey instead of typing your master password.`
						: t`Use Touch ID or Windows Hello instead of typing your master password.`
				}
			>
				{!adding ? (
					<Button
						variant="secondary"
						size="sm"
						onClick={() => {
							setError(null);
							setAdding(true);
						}}
					>
						<Trans>Add</Trans>
					</Button>
				) : null}
			</Row>

			{webauthnKeys.length > 0 && (
				<ul className="ml-12 mt-2 space-y-1.5">
					{webauthnKeys.map((k) => (
						<li
							key={k.slotIdB64}
							className="flex items-center justify-between gap-3 text-xs rounded-md border border-border/40 px-3 py-1.5"
						>
							<span className="flex items-center gap-2 min-w-0">
								{k.kind === "platform" ? (
									<Fingerprint className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
								) : (
									<KeyRound className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
								)}
								<span className="truncate">{k.label}</span>
								{/* Where this key actually works. Apple Passwords syncs across the account, so
								    one registration covers every Mac; Windows Hello is bound to the machine. */}
								{k.kind === "platform" && (
									<span className="text-muted-foreground shrink-0">
										{k.synced ? t`all your devices` : t`this device only`}
									</span>
								)}
							</span>
							<Button
								variant="link"
								size="none"
								onClick={() => void handleRevoke(k.slotIdB64)}
								className="hover:text-destructive transition-colors"
								aria-label={t`Remove ${k.label}`}
								title={t`Remove ${k.label}`}
							>
								×
							</Button>
						</li>
					))}
				</ul>
			)}

			{adding && (
				<div className="ml-12 mt-3 space-y-2">
					<input
						type="text"
						autoFocus
						value={label}
						onChange={(e) => setLabel(e.target.value)}
						placeholder={t`Name this key (optional)`}
						className="w-full px-3 py-1.5 text-xs rounded-lg border border-border bg-transparent focus:outline-none focus:border-primary/50"
						disabled={busy !== null}
					/>
					<div className="flex flex-wrap gap-2">
						<Button
							variant="primary"
							size="sm"
							onClick={() => handleAdd("platform")}
							disabled={busy !== null}
						>
							{busy === "platform" ? t`Confirm on your device…` : t`This device`}
						</Button>
						{canSecurityKeys && (
							<Button
								variant="secondary"
								size="sm"
								onClick={() => handleAdd("securityKey")}
								disabled={busy !== null}
							>
								{busy === "securityKey" ? t`Tap your key…` : t`Security key`}
							</Button>
						)}
						<Button
							variant="secondary"
							size="sm"
							onClick={() => {
								setAdding(false);
								setLabel("");
								setError(null);
							}}
							disabled={busy !== null}
						>
							<Trans>Cancel</Trans>
						</Button>
					</div>
					<p className="text-[11px] text-muted-foreground">
						<Trans>
							Registering with this device takes one tap. A security key takes two: one to create
							the key, then one to unlock its secret.
						</Trans>
					</p>
				</div>
			)}

			{error && <p className="ml-12 mt-2 text-xs text-destructive">{error}</p>}
		</>
	);
}
