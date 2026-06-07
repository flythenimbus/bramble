import { LifeBuoy } from "lucide-react";
import { useState } from "react";
import { useVault } from "../../../../hooks/useVault";
import { RecoveryCodeDisplay } from "../../../components/RecoveryCodeDisplay";
import { Modal } from "../../../components/ui/modal";
import { Row } from "./primitives";

export function RecoveryCodeSection() {
	const {
		hasPasswordSlot,
		hasRecoveryCode,
		verifyMasterPassword,
		verifyWithSecurityKey,
		generateRecoveryCode,
	} = useVault();
	const [gating, setGating] = useState(false); // showing the password-confirm input
	const [password, setPassword] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [freshCode, setFreshCode] = useState<string | null>(null);

	const begin = async () => {
		setError(null);
		if (hasPasswordSlot) {
			setPassword("");
			setGating(true);
			return;
		}
		setBusy(true);
		try {
			const ok = await verifyWithSecurityKey();
			if (!ok) {
				setError("Couldn't verify your security key. Try again.");
				return;
			}
			setFreshCode(await generateRecoveryCode());
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setBusy(false);
		}
	};

	const confirmWithPassword = async (e: React.FormEvent) => {
		e.preventDefault();
		setError(null);
		setBusy(true);
		try {
			const ok = await verifyMasterPassword(password);
			if (!ok) {
				setError("Incorrect master password");
				return;
			}
			setFreshCode(await generateRecoveryCode());
			setGating(false);
			setPassword("");
		} catch (err) {
			setError((err as Error).message);
		} finally {
			setBusy(false);
		}
	};

	return (
		<>
			<Row
				icon={<LifeBuoy className="w-4 h-4 text-primary" />}
				title="Recovery code"
				subtitle={
					hasRecoveryCode
						? "A one-time backup code that unlocks your vault if you're locked out."
						: "No recovery code yet. Generate one as a backup way in."
				}
			>
				{!gating && (
					<button
						type="button"
						onClick={() => void begin()}
						disabled={busy}
						className="px-3 py-1.5 text-xs rounded-lg border border-border hover:bg-primary/5 hover:border-primary/50 active:scale-[0.98] transition-all disabled:opacity-50"
					>
						{busy && !hasPasswordSlot ? "Tap your key…" : hasRecoveryCode ? "Reset" : "Generate"}
					</button>
				)}
			</Row>

			{hasRecoveryCode && !gating && (
				<p className="text-xs text-muted-foreground pl-12">Resetting invalidates your old code.</p>
			)}

			{gating && (
				<form className="ml-12 mt-2 space-y-2" onSubmit={confirmWithPassword}>
					<p className="text-xs text-muted-foreground">
						Confirm your master password to {hasRecoveryCode ? "reset" : "generate"} the recovery
						code.
					</p>
					<input
						type="password"
						autoFocus
						value={password}
						onChange={(e) => setPassword(e.target.value)}
						placeholder="Master password"
						disabled={busy}
						className="w-full px-3 py-1.5 text-xs rounded-lg border border-border bg-transparent focus:outline-none focus:border-primary/50"
					/>
					<div className="flex gap-2">
						<button
							type="submit"
							disabled={busy || !password}
							className="px-3 py-1.5 text-xs rounded-lg bg-primary text-primary-foreground border border-primary/20 hover:bg-primary/90 disabled:opacity-50"
						>
							{busy ? "Working…" : "Confirm"}
						</button>
						<button
							type="button"
							onClick={() => {
								setGating(false);
								setPassword("");
								setError(null);
							}}
							disabled={busy}
							className="px-3 py-1.5 text-xs rounded-lg border border-border hover:bg-primary/5 disabled:opacity-50"
						>
							Cancel
						</button>
					</div>
				</form>
			)}

			{error && <p className="ml-12 mt-2 text-xs text-destructive">{error}</p>}

			<Modal
				open={freshCode !== null}
				onClose={() => setFreshCode(null)}
				dismissable={false}
				className="max-w-lg"
			>
				<div className="p-6">
					{freshCode && (
						<RecoveryCodeDisplay
							code={freshCode}
							title="Your new recovery code"
							continueLabel="Done"
							onContinue={() => setFreshCode(null)}
						/>
					)}
				</div>
			</Modal>
		</>
	);
}
