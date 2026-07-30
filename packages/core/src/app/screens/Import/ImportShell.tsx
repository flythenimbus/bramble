import { Trans, useLingui } from "@lingui/react/macro";
import { ArrowLeft, ArrowLeftRight, Check, Loader2, ShieldCheck, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { usePlatform } from "../../../context/PlatformContext";
import { importFromOs } from "../../../exchange";
import {
	exchangeBlockedReason,
	useExchangeAvailability,
} from "../../../hooks/useExchangeAvailability";
import { useVault } from "../../../hooks/useVault";
import { useVaultRegistry } from "../../../hooks/useVaultRegistry";
import type { ImportProvider } from "../../../import";
import {
	IMPORT_PROVIDERS,
	type ImportProviderInfo,
	type ImportResult,
	kdbxEntriesToResult,
	parseImport,
} from "../../../import";
import { bytesToBase64 } from "../../../util/bytes";
import { Button } from "../../components/ui/button";
import { VaultChoiceList } from "../../components/VaultChoiceList";
import { Header } from "./components/Header";
import { KdbxUnlock } from "./components/KdbxUnlock";
import { Shell } from "./components/Shell";
import { UnlockGate } from "./components/UnlockGate";
import { countLine } from "./util/count-line";
import { kdbxErrorMessage } from "./util/kdbx-error";

// File-size ceiling for any import: above any realistic export, guards against
// OOM from a hostile or corrupt file.
const MAX_IMPORT_FILE_MB = 50;
const MAX_IMPORT_FILE_BYTES = MAX_IMPORT_FILE_MB * 1024 * 1024;

/** Import wizard: pick a provider, parse/decrypt the file, preview, then write into the vault.
 * `onClose` (single-window hosts like mobile) returns to the app; the extension opens import
 * in its own tab and passes nothing. */
export function ImportShell({ onClose }: { onClose?: () => void } = {}) {
	const { ready, hasVault, isLocked, unlock, importEntries } = useVault();
	const { shell, crypto, exchange } = usePlatform();
	const { vaults, selectVault } = useVaultRegistry();
	const { t } = useLingui();
	const [provider, setProvider] = useState<ImportProviderInfo | null>(null);
	const [result, setResult] = useState<ImportResult | null>(null);
	const [imported, setImported] = useState<number | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	// Encrypted .kdbx picked, awaiting its master password.
	const [kdbxPending, setKdbxPending] = useState<{
		provider: ImportProviderInfo;
		fileB64: string;
	} | null>(null);

	// The OS-transfer card shows wherever the build has the plugin; when this particular
	// device can't transfer, the card says why instead of disappearing.
	const availability = useExchangeAvailability();
	const exchangeBlocked = exchangeBlockedReason(availability);
	const providers = IMPORT_PROVIDERS.filter((p) => !p.viaSystem || exchange);

	// The OS opens this screen only because a transfer is already in flight, so claim it and
	// go straight to the preview. Showing the provider list first would ask the user to pick a
	// source they have already picked. Claims nothing when no transfer is waiting (the normal
	// case, when the user opened Import themselves), and then the list is exactly right.
	// Is a transfer waiting? Peeked (not claimed) so the destination can be settled first.
	const [transferPending, setTransferPending] = useState(false);
	const [vaultChosen, setVaultChosen] = useState(false);
	const needsVaultChoice = transferPending && vaults.length > 1 && !vaultChosen;
	useEffect(() => {
		if (!exchange) return;
		void exchange
			.hasPendingImport()
			.then(setTransferPending)
			.catch(() => {});
	}, [exchange]);

	const claimed = useRef(false);
	useEffect(() => {
		if (!exchange || !ready || isLocked || needsVaultChoice || claimed.current) return;
		claimed.current = true;
		void (async () => {
			setBusy(true);
			try {
				const res = await importFromOs(exchange);
				const card = IMPORT_PROVIDERS.find((p) => p.viaSystem);
				if (res && res.imported.length > 0 && card) {
					setProvider(card);
					setResult(res);
				}
			} catch {
				// Fall through to the provider list rather than blocking it behind an error the
				// user can do nothing about; the card is still there to retry.
			} finally {
				setBusy(false);
			}
		})();
	}, [exchange, ready, isLocked, needsVaultChoice]);

	// Wait for hydration before rendering, else we flash the wrong state.
	if (!ready) {
		return (
			<Shell onClose={onClose}>
				<div className="flex justify-center py-12">
					<Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
				</div>
			</Shell>
		);
	}

	// An inbound transfer with more than one vault: ask where it lands. The launch-time picker
	// is skipped when the OS opens us here, and the registry restores whichever vault was used
	// last, so without this the credentials would silently go to "the last one you opened"
	// rather than the one the user meant.
	if (needsVaultChoice) {
		return (
			<Shell onClose={onClose}>
				<Header subtitle={t`Choose the vault these items should go into`} />
				<VaultChoiceList
					onSelect={(id) => {
						selectVault(id);
						setVaultChosen(true);
					}}
				/>
			</Shell>
		);
	}

	if (!hasVault) {
		return (
			<Shell onClose={onClose}>
				<Header subtitle={t`You need a vault before you can import into it`} />
				<div className="rounded-lg border border-border/50 bg-card/50 backdrop-blur-sm p-6 text-center space-y-4">
					<p className="text-sm text-muted-foreground">
						<Trans>Set up your {shell.appName} vault first, then come back to import.</Trans>
					</p>
					<Button
						variant="primary"
						size="none"
						onClick={() => window.location.assign(window.location.pathname)}
						className="px-5 py-2.5 text-sm"
					>
						<Trans>Set up a vault</Trans>
					</Button>
				</div>
			</Shell>
		);
	}

	if (isLocked) return <UnlockGate onUnlock={unlock} />;

	if (imported !== null) {
		return (
			<Shell onClose={onClose}>
				<div className="rounded-lg border border-border/50 bg-card/50 backdrop-blur-sm p-8 text-center space-y-3">
					<div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-linear-to-br from-primary to-primary/80">
						<Check className="w-7 h-7 text-primary-foreground" />
					</div>
					<h1 className="text-2xl">
						<Trans>Imported {imported} items</Trans>
					</h1>
					<p className="text-sm text-muted-foreground">
						{provider?.viaSystem ? (
							// Nothing was written to disk: the OS moved the payload app to app.
							<Trans>
								They're in your vault now. The transfer happened directly between the two apps, so
								there's no file to clean up.
							</Trans>
						) : (
							<Trans>
								They're in your vault now. For your safety, delete the export file you just
								imported, as it holds your passwords in plain text.
							</Trans>
						)}
					</p>
					{onClose && (
						<Button variant="primary" size="none" onClick={onClose} className="px-5 py-2.5 text-sm">
							<Trans>Done</Trans>
						</Button>
					)}
				</div>
			</Shell>
		);
	}

	const onFile = async (p: ImportProviderInfo, file: File | undefined) => {
		if (!file) return;
		setError(null);
		setBusy(true);
		try {
			if (file.size > MAX_IMPORT_FILE_BYTES) {
				const sizeMb = (file.size / 1024 / 1024).toFixed(1);
				setError(t`This file is too large to import (${sizeMb} MB; max ${MAX_IMPORT_FILE_MB} MB).`);
				return;
			}
			// Encrypted .kdbx: stash bytes, collect the password in the next step.
			if (p.needsCredential) {
				const bytes = new Uint8Array(await file.arrayBuffer());
				setKdbxPending({ provider: p, fileB64: bytesToBase64(bytes) });
				return;
			}
			const raw = p.reads === "text" ? await file.text() : new Uint8Array(await file.arrayBuffer());
			const res = await parseImport(p.id as ImportProvider, raw, {
				passkeyImportPkcs8: (pkcs8StandardB64) => crypto.passkeyImportPkcs8(pkcs8StandardB64),
			});
			if (res.imported.length === 0) {
				// Distinguish an empty file from one where all items failed validation.
				const noun = res.skipped === 1 ? t`item` : t`items`;
				setError(
					res.skipped > 0
						? t`This file held ${res.skipped} ${noun}, but none matched a supported format.`
						: t`No importable items were found in this file.`,
				);
				return;
			}
			setProvider(p);
			setResult(res);
		} catch (err) {
			setError(err instanceof Error ? err.message : t`Couldn't read this file.`);
		} finally {
			setBusy(false);
		}
	};

	// Pull an OS-delivered transfer (FIDO CXP). The other app starts it and the OS launches us,
	// so most of the time there is nothing waiting and we say so rather than failing.
	const onSystemTransfer = async (p: ImportProviderInfo) => {
		if (!exchange) return;
		setError(null);
		setBusy(true);
		try {
			const res = await importFromOs(exchange);
			if (!res) {
				setError(
					t`No transfer is waiting. Start one from the other app and pick ${shell.appName}.`,
				);
				return;
			}
			if (res.imported.length === 0) {
				setError(t`That transfer didn't contain anything we could import.`);
				return;
			}
			setProvider(p);
			setResult(res);
		} catch (err) {
			setError(err instanceof Error ? err.message : t`Couldn't read that transfer.`);
		} finally {
			setBusy(false);
		}
	};

	// Open the pending .kdbx in WASM, then preview. Throws a friendly message
	// (caught by KdbxUnlock) so a wrong password keeps the user on this step.
	const openKdbxAndPreview = async (password: string, keyfileB64?: string) => {
		if (!kdbxPending) return;
		let entries: Awaited<ReturnType<typeof crypto.openKdbx>>;
		try {
			entries = await crypto.openKdbx({ fileB64: kdbxPending.fileB64, password, keyfileB64 });
		} catch (err) {
			throw new Error(kdbxErrorMessage(err));
		}
		const res = kdbxEntriesToResult(entries);
		if (res.imported.length === 0) {
			throw new Error(t`No importable items were found in this database.`);
		}
		setProvider(kdbxPending.provider);
		setResult(res);
		setKdbxPending(null);
	};

	const runImport = async () => {
		if (!result) return;
		setBusy(true);
		setError(null);
		try {
			await importEntries(result.imported);
			setImported(result.imported.length);
		} catch (err) {
			setError(err instanceof Error ? err.message : t`Couldn't write to the vault.`);
		} finally {
			setBusy(false);
		}
	};

	if (result && provider) {
		return (
			<Shell onClose={onClose}>
				<Header subtitle={t`Review what we found in your ${provider.label} export`} />
				<div className="rounded-lg border border-border/50 bg-card/50 backdrop-blur-sm overflow-hidden">
					<div className="p-4 space-y-3">
						<div className="flex items-center gap-2.5">
							<ShieldCheck className="w-5 h-5 text-primary shrink-0" />
							<p className="text-sm">
								<Trans>
									<span className="text-base">{result.imported.length}</span> items ready to import
								</Trans>
							</p>
						</div>
						<p className="text-xs text-muted-foreground">{countLine(result)}</p>
						{result.warnings.length > 0 && (
							<ul className="text-xs text-yellow-500 space-y-1 list-disc pl-4">
								{result.warnings.slice(0, 8).map((w) => (
									<li key={w}>{w}</li>
								))}
								{result.warnings.length > 8 && (
									<li>
										<Trans>…and {result.warnings.length - 8} more</Trans>
									</li>
								)}
							</ul>
						)}
						{error && <p className="text-xs text-destructive">{error}</p>}
					</div>
					<div className="p-4 bg-muted/30 border-t border-border/50 flex items-center justify-between gap-3">
						<Button
							variant="secondary"
							size="none"
							onClick={() => {
								setResult(null);
								setProvider(null);
								setError(null);
							}}
							disabled={busy}
							className="px-4 py-2 text-sm hover:bg-background/50"
						>
							<ArrowLeft className="w-3.5 h-3.5" />
							<Trans>Choose another file</Trans>
						</Button>
						<Button variant="primary" size="md" onClick={runImport} disabled={busy}>
							{busy ? (
								<>
									<Loader2 className="w-3.5 h-3.5 animate-spin" />
									<Trans>Importing…</Trans>
								</>
							) : (
								<Trans>Import {result.imported.length} items</Trans>
							)}
						</Button>
					</div>
				</div>
			</Shell>
		);
	}

	if (kdbxPending) {
		return (
			<KdbxUnlock
				providerLabel={kdbxPending.provider.label}
				onOpen={openKdbxAndPreview}
				onBack={() => {
					setKdbxPending(null);
					setError(null);
				}}
			/>
		);
	}

	return (
		<Shell onClose={onClose}>
			<Header subtitle={t`Bring your logins, cards and notes over from another manager`} />
			<div className="space-y-2.5">
				{providers.map((p) =>
					p.viaSystem ? (
						<button
							key={p.id}
							type="button"
							disabled={busy || exchangeBlocked !== null}
							onClick={() => void onSystemTransfer(p)}
							className="w-full flex items-center gap-3 p-4 rounded-lg border border-border/50 bg-card/50 backdrop-blur-sm text-left hover:border-border hover:bg-card/80 active:scale-[0.99] transition-all disabled:opacity-60"
						>
							<div className="flex items-center justify-center w-10 h-10 rounded-lg bg-linear-to-br from-primary/20 to-primary/10 shrink-0">
								<ArrowLeftRight className="w-4 h-4 text-primary" />
							</div>
							<div className="min-w-0 flex-1">
								<p className="text-sm">{p.label}</p>
								<p className="text-xs text-muted-foreground">{exchangeBlocked ?? p.blurb}</p>
							</div>
						</button>
					) : (
						<label
							key={p.id}
							className="flex items-center gap-3 p-4 rounded-lg border border-border/50 bg-card/50 backdrop-blur-sm cursor-pointer hover:border-border hover:bg-card/80 active:scale-[0.99] transition-all"
						>
							<input
								type="file"
								accept={p.accept}
								className="hidden"
								// Keep the vault unlocked while the OS picker backgrounds the app (mobile).
								onClick={() => shell.notifyFilePickerOpening?.()}
								onChange={(e) => {
									// Reset value after handling so re-picking the same file fires onChange again.
									const input = e.currentTarget;
									void onFile(p, input.files?.[0]).finally(() => {
										input.value = "";
									});
								}}
							/>
							<div className="flex items-center justify-center w-10 h-10 rounded-lg bg-linear-to-br from-primary/20 to-primary/10 shrink-0">
								<span className="text-sm text-primary">{p.label.charAt(0)}</span>
							</div>
							<div className="min-w-0 flex-1">
								<p className="text-sm">{p.label}</p>
								<p className="text-xs text-muted-foreground truncate">{p.blurb}</p>
							</div>
							<Upload className="w-4 h-4 text-muted-foreground shrink-0" />
						</label>
					),
				)}
			</div>
			{busy && (
				<div className="flex items-center justify-center gap-2 mt-4 text-sm text-muted-foreground">
					<Loader2 className="w-4 h-4 animate-spin" />
					<Trans>Reading file…</Trans>
				</div>
			)}
			{error && <p className="text-sm text-destructive text-center mt-4">{error}</p>}
			<p className="text-xs text-muted-foreground text-center mt-6">
				<Trans>
					Files are read on this device only. Nothing is uploaded. Delete the export file once
					you're done.
				</Trans>
			</p>
		</Shell>
	);
}
