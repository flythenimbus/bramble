import { Trans, useLingui } from "@lingui/react/macro";
import { ArchiveRestore, ArrowLeft, Check, Loader2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { usePlatform } from "../../../context/PlatformContext";
import { useVault } from "../../../hooks/useVault";
import { useVaultRegistry } from "../../../hooks/useVaultRegistry";
import { bytesToBase64 } from "../../../util/bytes";
import {
	decodeVaultBlob,
	findPasswordSlot,
	type PasswordSlot,
	verifierPrefix,
} from "../../../vault-format";
import { PasswordField } from "../../components/ui/password-field";

// Above any realistic vault; guards against OOM from a hostile/corrupt file.
const MAX_RESTORE_MB = 100;

function Wrapper({ children, onClose }: { children: React.ReactNode; onClose?: () => void }) {
	const { t } = useLingui();
	return (
		<div className="relative min-h-screen bg-gradient-to-br from-background via-background to-primary/5 flex items-center justify-center p-6">
			{onClose && (
				<button
					type="button"
					onClick={onClose}
					aria-label={t`Close`}
					className="absolute top-4 right-4 z-10 p-2 rounded-lg border border-transparent text-muted-foreground hover:bg-primary/10 hover:border-border hover:text-foreground active:scale-[0.95] transition-all"
				>
					<X className="w-4 h-4" />
				</button>
			)}
			<div className="w-full max-w-xl">{children}</div>
		</div>
	);
}

/**
 * Restore a .bramble backup: validate the VLT1 blob and verify the backup's master password
 * (non-destructively). If no vault exists yet, it fills the first vault and unlocks it. If a vault
 * already exists, it is added as a NEW vault (never overwriting an existing one) and left locked to
 * open from the picker. Opened in the setup tab via shell.openSetup("restore"). See
 * docs/cloud-storage-backups.md and docs/multiple-vaults.md (Restore destination).
 */
export function RestoreShell({
	onClose,
	onRestored,
	mobile,
}: {
	onClose?: () => void;
	/** Called after a successful restore+unlock instead of showing the terminal "Vault restored"
	 * screen. Used when embedded in the setup flow, which owns the post-unlock screen. */
	onRestored?: () => void;
	/** Loosen the file `accept` so the native mobile document picker doesn't grey out .bramble
	 * (no UTType/MIME is registered for the custom extension). */
	mobile?: boolean;
} = {}) {
	const { unlock } = useVault();
	const { createRecord } = useVaultRegistry();
	const { shell, crypto, storage } = usePlatform();
	const { t } = useLingui();
	// Whether a vault already exists here: gates the "this replaces your vault" warning, which is
	// wrong on a fresh install (nothing to replace, e.g. onboarding restore on mobile).
	const [hasVault, setHasVault] = useState(false);
	useEffect(() => {
		let alive = true;
		storage
			.hasVaultHandle()
			.then((v) => {
				if (alive) setHasVault(v);
			})
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, [storage]);
	const [picked, setPicked] = useState<{
		bytes: Uint8Array;
		slot: PasswordSlot;
		name: string;
	} | null>(null);
	const [password, setPassword] = useState("");
	// Optional name for the restored vault when it's added as a new one (vaults already exist).
	const [label, setLabel] = useState("");
	const [busy, setBusy] = useState(false);
	const [done, setDone] = useState(false);
	// True when the restore added a new vault (locked, to unlock from the picker) rather than
	// filling the first/only vault (which is unlocked in place). Changes the terminal message.
	const [addedNew, setAddedNew] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const onFile = async (file: File | undefined) => {
		if (!file) return;
		setError(null);
		setBusy(true);
		try {
			if (file.size > MAX_RESTORE_MB * 1024 * 1024) {
				setError(t`This file is too large to be a Bramble backup.`);
				return;
			}
			const bytes = new Uint8Array(await file.arrayBuffer());
			let slot: PasswordSlot | null;
			try {
				slot = findPasswordSlot(decodeVaultBlob(bytes));
			} catch {
				setError(t`That doesn't look like a Bramble backup (.bramble) file.`);
				return;
			}
			if (!slot) {
				setError(t`This backup has no master password, so it can't be restored here.`);
				return;
			}
			setPicked({ bytes, slot, name: file.name });
			setPassword("");
		} catch (e) {
			setError(e instanceof Error ? e.message : t`Couldn't read this file.`);
		} finally {
			setBusy(false);
		}
	};

	const restore = async () => {
		if (!picked || !password) return;
		setBusy(true);
		setError(null);
		try {
			// Verify the backup's password BEFORE replacing anything, so a typo can't
			// destroy the vault currently on this device.
			const ok = await crypto.verifyPasswordSlot({
				password,
				saltB64: bytesToBase64(picked.slot.salt),
				slotIdB64: bytesToBase64(picked.slot.slotId),
				verifierB64: bytesToBase64(picked.slot.verifier),
				magicVersion: verifierPrefix(),
			});
			if (!ok) {
				setError(t`Incorrect master password for this backup.`);
				return;
			}
			if (hasVault) {
				// A vault already exists: NEVER overwrite it. Restore into a brand-new vault so the
				// user can't lose the vault currently on this device to a stray restore. Its sync
				// identity is empty (namespaced keys don't exist yet), so no reset is needed and other
				// vaults' sync state is untouched. It's created locked; the user unlocks it from the
				// picker with the backup's password. See docs/multiple-vaults.md (Restore destination).
				const newId = await createRecord(label.trim());
				await storage.writeVaultBlob(picked.bytes, newId);
				setAddedNew(true);
				setDone(true);
			} else {
				// First/only vault on this device: fill it in place and unlock.
				await storage.writeVaultBlob(picked.bytes); // snapshots the previous vault first
				await shell.resetSyncState?.(); // fresh sync identity; the restored vault isn't enrolled
				await unlock(password); // reads the freshly-written blob and loads its VEK
				if (onRestored) onRestored();
				else setDone(true);
			}
		} catch (e) {
			setError(e instanceof Error ? e.message : t`Couldn't restore this backup.`);
		} finally {
			setBusy(false);
		}
	};

	if (done) {
		return (
			<Wrapper onClose={onClose}>
				<div className="rounded-lg border border-border/50 bg-card/50 backdrop-blur-sm p-8 text-center space-y-3">
					<div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-gradient-to-br from-primary to-primary/80">
						<Check className="w-7 h-7 text-primary-foreground" />
					</div>
					<h1 className="text-2xl">
						{addedNew ? <Trans>Vault added</Trans> : <Trans>Vault restored</Trans>}
					</h1>
					<p className="text-sm text-muted-foreground">
						{addedNew ? (
							<Trans>
								Your backup was added as a new vault. Open it from the vault list and unlock it with
								its master password.
							</Trans>
						) : onClose ? (
							<Trans>Your backup is now the vault on this device.</Trans>
						) : (
							<Trans>
								Your backup is now the vault on this device. You can close this tab and use the{" "}
								{shell.appName} popup.
							</Trans>
						)}
					</p>
					{onClose && (
						<button
							type="button"
							onClick={onClose}
							className="px-5 py-2.5 text-sm rounded-lg bg-primary text-primary-foreground border border-primary/20 hover:bg-primary/90 active:scale-[0.98] transition-all"
						>
							<Trans>Done</Trans>
						</button>
					)}
				</div>
			</Wrapper>
		);
	}

	return (
		<Wrapper onClose={onClose}>
			<div className="text-center mb-6">
				<div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-gradient-to-br from-primary to-primary/80 mb-3">
					<ArchiveRestore className="w-7 h-7 text-primary-foreground" />
				</div>
				<h1 className="text-2xl">
					<Trans>Restore a backup</Trans>
				</h1>
				<p className="text-sm text-muted-foreground mt-1">
					<Trans>Open an encrypted .bramble backup and make it the vault on this device.</Trans>
				</p>
			</div>

			{!picked ? (
				<>
					<label className="flex items-center gap-3 p-4 rounded-lg border border-border/50 bg-card/50 backdrop-blur-sm cursor-pointer hover:border-border hover:bg-card/80 active:scale-[0.99] transition-all">
						<input
							type="file"
							// Desktop filters to .bramble; mobile omits it so the native picker shows the file.
							accept={mobile ? undefined : ".bramble"}
							className="hidden"
							// Keep the vault unlocked while the OS picker backgrounds the app (mobile).
							onClick={() => shell.notifyFilePickerOpening?.()}
							onChange={(e) => {
								const input = e.currentTarget;
								void onFile(input.files?.[0]).finally(() => {
									input.value = "";
								});
							}}
						/>
						<div className="flex items-center justify-center w-10 h-10 rounded-lg bg-linear-to-br from-primary/20 to-primary/10 shrink-0">
							<ArchiveRestore className="w-5 h-5 text-primary" />
						</div>
						<div className="min-w-0 flex-1">
							<p className="text-sm">
								<Trans>Choose a .bramble file</Trans>
							</p>
							<p className="text-xs text-muted-foreground">
								<Trans>The one you saved with Export a backup, or a cloud backup.</Trans>
							</p>
						</div>
					</label>
					{busy && (
						<div className="flex items-center justify-center gap-2 mt-4 text-sm text-muted-foreground">
							<Loader2 className="w-4 h-4 animate-spin" />
							<Trans>Reading file…</Trans>
						</div>
					)}
					{error && <p className="text-sm text-destructive text-center mt-4">{error}</p>}
				</>
			) : (
				<form
					className="rounded-lg border border-border/50 bg-card/50 backdrop-blur-sm p-5 space-y-4"
					onSubmit={(e) => {
						e.preventDefault();
						void restore();
					}}
				>
					{hasVault ? (
						<>
							<p className="text-xs text-muted-foreground">
								<Trans>
									Restore <span className="text-foreground">{picked.name}</span> as a new vault.
									Your existing vaults are left untouched. Enter its master password.
								</Trans>
							</p>
							<div>
								<label htmlFor="restore-label" className="block text-sm mb-1.5">
									<Trans>Vault name</Trans>
								</label>
								<input
									id="restore-label"
									type="text"
									placeholder={t`Optional (e.g. Restored)`}
									autoComplete="off"
									value={label}
									onChange={(e) => setLabel(e.target.value)}
									className="w-full px-3 py-2 text-sm rounded-lg border border-border bg-transparent focus:outline-none focus:border-primary/50"
								/>
							</div>
						</>
					) : (
						<p className="text-xs text-muted-foreground">
							<Trans>
								Open <span className="text-foreground">{picked.name}</span> as the vault on this
								device. Enter its master password.
							</Trans>
						</p>
					)}
					<PasswordField
						label={t`Backup's master password`}
						value={password}
						autoFocus
						onChange={(e) => setPassword(e.target.value)}
						error={error ?? undefined}
					/>
					<div className="flex items-center justify-between gap-3">
						<button
							type="button"
							onClick={() => {
								setPicked(null);
								setPassword("");
								setError(null);
							}}
							disabled={busy}
							className="flex items-center gap-2 px-4 py-2 text-sm rounded-lg border border-border hover:bg-background/50 active:scale-[0.98] transition-all disabled:opacity-50"
						>
							<ArrowLeft className="w-3.5 h-3.5" />
							<Trans>Choose another file</Trans>
						</button>
						<button
							type="submit"
							disabled={busy || !password}
							className="flex items-center gap-2 px-5 py-2 text-sm rounded-lg bg-primary text-primary-foreground border border-primary/20 hover:bg-primary/90 active:scale-[0.98] transition-all disabled:opacity-50"
						>
							{busy ? (
								<>
									<Loader2 className="w-3.5 h-3.5 animate-spin" />
									<Trans>Restoring…</Trans>
								</>
							) : (
								<Trans>Restore vault</Trans>
							)}
						</button>
					</div>
				</form>
			)}
		</Wrapper>
	);
}
