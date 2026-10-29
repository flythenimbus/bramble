import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { ArrowLeft, ArrowLeftRight, Check, Loader2, ShieldCheck, Upload } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isBackupArchive } from "../../../backup/archive";
import { usePlatform } from "../../../context/PlatformContext";
import { importFromOs } from "../../../exchange";
import {
	FULL_BACKUP_ERROR,
	openPortableVaultFile,
	readPortableVaultFile,
} from "../../../export/portable-vault";
import {
	exchangeBlockedReason,
	useExchangeAvailability,
} from "../../../hooks/useExchangeAvailability";
import { type EntryData, useVault } from "../../../hooks/useVault";
import { useVaultRegistry } from "../../../hooks/useVaultRegistry";
import type { ImportParserContext, ImportProvider, PlacedAttachment } from "../../../import";
import {
	IMPORT_PROVIDERS,
	type ImportProviderInfo,
	type ImportResult,
	kdbxEntriesToResult,
	parseImport,
	tallyByType,
} from "../../../import";
import { base64ToBytes } from "../../../util/bytes";
import { splitAlreadyImported } from "../../../vault/entry-identity";
import { plaintextSize } from "../../../vault/file-mutations";
import { FilePickerRow } from "../../components/FilePickerRow";
import { Button } from "../../components/ui/button";
import { VaultChoiceList } from "../../components/VaultChoiceList";
import { useCanAddFiles } from "../../hooks/useCanAddFiles";
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
	const { ready, hasVault, isLocked, unlock, importEntries, entries, files, describeFile } =
		useVault();
	const { shell, crypto, exchange } = usePlatform();
	const { vaults, selectVault } = useVaultRegistry();
	const { t } = useLingui();
	const [provider, setProvider] = useState<ImportProviderInfo | null>(null);
	const [result, setResult] = useState<ImportResult | null>(null);
	const [imported, setImported] = useState<number | null>(null);
	const [importedFiles, setImportedFiles] = useState(0);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	// Encrypted .kdbx picked, awaiting its master password.
	const [kdbxPending, setKdbxPending] = useState<{
		provider: ImportProviderInfo;
		file: Uint8Array;
	} | null>(null);
	// The files a KeePass import brings, placed on their entries, and what holds them until then:
	// they are the database's attachments in the clear, so they go as soon as they are sealed,
	// or as soon as the import is abandoned.
	const [attachments, setAttachments] = useState<PlacedAttachment[]>([]);
	// Where this browser can't add files (see useCanAddFiles), the file's attachments stay out, counted.
	const canAddFiles = useCanAddFiles();
	const [skippedFiles, setSkippedFiles] = useState(0);
	const releaseRef = useRef<(() => Promise<void>) | null>(null);
	const release = useCallback(() => {
		const drop = releaseRef.current;
		releaseRef.current = null;
		void drop?.().catch(() => {});
	}, []);
	useEffect(() => release, [release]);
	// A lock clears what an import unpacked, so a preview that outlived one would offer files
	// that are gone. Start over instead, and say why.
	useEffect(() => {
		if (!isLocked || !releaseRef.current) return;
		release();
		setResult(null);
		setProvider(null);
		setAttachments([]);
		setError(
			t`The vault locked, so the attachments read from that file were cleared. Open it again to import them.`,
		);
	}, [isLocked, release, t]);

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
	// Null until the peek answers, which the claim below waits for: on an app that is already
	// unlocked the claim would otherwise win the race and import into the restored vault
	// before we knew to ask which vault the user wanted.
	const [transferPending, setTransferPending] = useState<boolean | null>(null);
	const [vaultChosen, setVaultChosen] = useState(false);
	const needsVaultChoice = transferPending === true && vaults.length > 1 && !vaultChosen;
	useEffect(() => {
		if (!exchange) return;
		void exchange
			.hasPendingImport()
			.then(setTransferPending)
			.catch(() => setTransferPending(false));
	}, [exchange]);

	// Crypto the importers may need: converting a foreign passkey key runs in the Rust core.
	const parserContext = useMemo<ImportParserContext>(
		() => ({ passkeyImportPkcs8: (b64) => crypto.passkeyImportPkcs8(b64) }),
		[crypto],
	);

	// Re-importing the same file is the common accident (github issue #39), so drop what the
	// vault already holds before the preview rather than after the write. Counted, never silent.
	const [duplicates, setDuplicates] = useState(0);
	// The same credential in another manager's shape: kept out unless the user asks for it.
	const [heldBack, setHeldBack] = useState<EntryData[]>([]);
	const [passwordDiffers, setPasswordDiffers] = useState(0);
	// The previewed file as parsed, before the split, so held-back entries can be placed again.
	const source = useRef<ImportResult | null>(null);
	const showResult = useCallback(
		(res: ImportResult, placed: PlacedAttachment[] = []) => {
			const split = splitAlreadyImported(entries, res.imported);
			source.current = res;
			setDuplicates(split.duplicates);
			setHeldBack(split.likelyDuplicates);
			setPasswordDiffers(split.passwordDiffers);
			setAttachments(placed);
			setSkippedFiles(canAddFiles ? 0 : (res.attachments?.length ?? 0));
			const offered = split.fresh.length + split.likelyDuplicates.length + placed.length;
			if (offered > 0) {
				setResult({ ...res, imported: split.fresh, byType: tallyByType(split.fresh) });
			}
			return offered;
		},
		[entries, canAddFiles],
	);

	// Each file follows its entry: onto the copy kept of an entry the file repeats, or, for one
	// the vault already holds, onto that entry. That is what lets re-importing a database bring
	// the files an earlier import could not, unless that entry already has them. A held-back
	// entry counts as the one it resembles until the user imports it anyway.
	const placeAttachments = useCallback(
		async (res: ImportResult, withHeldBack = false): Promise<PlacedAttachment[]> => {
			if (!canAddFiles) return [];
			const { sameAs, resembles } = splitAlreadyImported(entries, res.imported);
			const placed: PlacedAttachment[] = [];
			for (const { entry, ...file } of res.attachments ?? []) {
				let to = sameAs.get(entry) ?? entry;
				if (typeof to !== "string" && !withHeldBack) to = resembles.get(to) ?? to;
				if (typeof to !== "string") {
					placed.push({ ...file, onto: { item: to } });
					continue;
				}
				let present = false;
				for (const held of files) {
					if (held.entryId !== to || plaintextSize(held.size) !== file.size) continue;
					if ((await describeFile(held).catch(() => null))?.name === file.name) {
						present = true;
						break;
					}
				}
				if (!present) placed.push({ ...file, onto: { entryId: to } });
			}
			return placed;
		},
		[entries, files, describeFile, canAddFiles],
	);
	const importHeldBack = async () => {
		setResult((r) => {
			if (!r) return r;
			const imported = [...r.imported, ...heldBack];
			return { ...r, imported, byType: tallyByType(imported) };
		});
		setHeldBack([]);
		if (source.current?.attachments?.length) {
			setAttachments(await placeAttachments(source.current, true));
		}
	};

	const claimed = useRef(false);
	useEffect(() => {
		if (!exchange || !ready || isLocked || claimed.current) return;
		// Wait for the peek, then for the destination if one has to be chosen.
		if (transferPending === null || needsVaultChoice) return;
		claimed.current = true;
		void (async () => {
			setBusy(true);
			try {
				const res = await importFromOs(exchange, parserContext);
				const card = IMPORT_PROVIDERS.find((p) => p.viaSystem);
				if (res && res.imported.length > 0 && card && showResult(res) > 0) {
					setProvider(card);
				}
			} catch {
				// Fall through to the provider list rather than blocking it behind an error the
				// user can do nothing about; the card is still there to retry.
			} finally {
				setBusy(false);
			}
		})();
	}, [exchange, ready, isLocked, transferPending, needsVaultChoice, parserContext, showResult]);

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
						{imported > 0 ? (
							<Trans>Imported {imported} items</Trans>
						) : (
							<Plural value={importedFiles} one="Added # attachment" other="Added # attachments" />
						)}
					</h1>
					{imported > 0 && importedFiles > 0 && (
						<p className="text-sm">
							<Plural
								value={importedFiles}
								one="# attachment came with them."
								other="# attachments came with them."
							/>
						</p>
					)}
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
				setKdbxPending({ provider: p, file: new Uint8Array(await file.arrayBuffer()) });
				return;
			}
			const raw = p.reads === "text" ? await file.text() : new Uint8Array(await file.arrayBuffer());
			const res = await parseImport(p.id as ImportProvider, raw, parserContext);
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
			if (showResult(res) === 0) {
				setError(
					t`Everything in this file is already in your vault, so there is nothing to import.`,
				);
				return;
			}
			setProvider(p);
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
			const res = await importFromOs(exchange, parserContext);
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
			if (showResult(res) === 0) {
				setError(
					t`Everything in that transfer is already in your vault, so there is nothing to import.`,
				);
				return;
			}
			setProvider(p);
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
		try {
			const res =
				kdbxPending.provider.id === "bramble"
					? await openBrambleFile(password)
					: await openKdbxFile(password, keyfileB64);
			if (res.imported.length === 0) {
				throw new Error(t`No importable items were found in this database.`);
			}
			if (showResult(res, await placeAttachments(res)) === 0)
				throw new Error(
					!canAddFiles && res.attachments?.length
						? t`The only new things in this file are attachments, which this browser can add only once it's linked to the Bramble desktop app.`
						: t`Everything in this file is already in your vault, so there is nothing to import.`,
				);
		} catch (e) {
			release();
			throw e;
		}
		setProvider(kdbxPending.provider);
		setKdbxPending(null);
	};

	const openKdbxFile = async (password: string, keyfileB64?: string) => {
		if (!kdbxPending) throw new Error("no pending file");
		try {
			const opened = await crypto.openKdbx({
				file: kdbxPending.file,
				password,
				keyfile: keyfileB64 ? base64ToBytes(keyfileB64) : undefined,
			});
			releaseRef.current = opened.release;
			return await kdbxEntriesToResult(opened, parserContext);
		} catch (err) {
			throw new Error(kdbxErrorMessage(err));
		}
	};

	// Bramble's own format. Entries come back already normalized, so unlike every foreign
	// format there is nothing to map: passkeys and password history ride along untouched.
	const openBrambleFile = async (password: string): Promise<ImportResult> => {
		if (!kdbxPending) throw new Error("no pending file");
		// Import merges entries into this vault; a full backup is a whole vault and belongs in
		// Restore, which adds it as a new one. Said the same way for both kinds, the plain vault
		// (found once its payload is open) and the archive with attachments (found by its shape).
		const fullBackup = t`That's a full vault backup. Restore it instead: it's added as a new vault, and nothing here is changed.`;
		const bytes = kdbxPending.file;
		if (await isBackupArchive(bytes)) throw new Error(fullBackup);
		const file = readPortableVaultFile(bytes);
		if (!file) throw new Error(t`That doesn't look like a Bramble export (.bramble) file.`);
		let entries: Awaited<ReturnType<typeof openPortableVaultFile>>;
		try {
			entries = await openPortableVaultFile(crypto, file, password);
		} catch (e) {
			if (e instanceof Error && e.message === FULL_BACKUP_ERROR) throw new Error(fullBackup);
			throw e;
		}
		// null is a wrong password, distinct from a file this can't read at all.
		if (entries === null) throw new Error(t`That password didn't open the file.`);
		return { imported: entries, byType: tallyByType(entries), skipped: 0, warnings: [] };
	};

	const runImport = async () => {
		if (!result) return;
		setBusy(true);
		setError(null);
		try {
			await importEntries(result.imported, attachments);
			setImported(result.imported.length);
			setImportedFiles(attachments.length);
			release();
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
								{result.imported.length > 0 ? (
									<Trans>
										<span className="text-base">{result.imported.length}</span> items ready to
										import
									</Trans>
								) : (
									<Trans>Attachments ready to add to entries you already have</Trans>
								)}
							</p>
						</div>
						{result.imported.length > 0 && (
							<p className="text-xs text-muted-foreground">{countLine(result)}</p>
						)}
						{attachments.length > 0 && (
							<p className="text-xs text-muted-foreground">
								<AttachmentsLine placed={attachments} />
							</p>
						)}
						{skippedFiles > 0 && (
							<p className="text-xs text-muted-foreground">
								<Plural
									value={skippedFiles}
									one="# attachment in this file is left out: this browser can add files only once it's linked to the Bramble desktop app."
									other="# attachments in this file are left out: this browser can add files only once it's linked to the Bramble desktop app."
								/>
							</p>
						)}
						{duplicates > 0 && (
							<p className="text-xs text-muted-foreground">
								<Trans>
									{duplicates} more were already in your vault and will not be added again.
								</Trans>
							</p>
						)}
						{heldBack.length > 0 && (
							<div className="space-y-2">
								<p className="text-xs text-muted-foreground">
									<Trans>
										{heldBack.length} more look like entries you already have (the same site,
										username and password, or the same card number), so they are held back.
									</Trans>
								</p>
								<Button variant="secondary" size="sm" onClick={importHeldBack} disabled={busy}>
									<Trans>Import them anyway</Trans>
								</Button>
							</div>
						)}
						{passwordDiffers > 0 && (
							<p className="text-xs text-muted-foreground">
								<Trans>
									{passwordDiffers} share a site and username with an entry you already have, but
									with a different password. They will be added as new entries.
								</Trans>
							</p>
						)}
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
								release();
								setResult(null);
								setAttachments([]);
								setProvider(null);
								setError(null);
							}}
							disabled={busy}
							className="px-4 py-2 text-sm hover:bg-background/50"
						>
							<ArrowLeft className="w-3.5 h-3.5" />
							<Trans>Choose another file</Trans>
						</Button>
						<Button
							variant="primary"
							size="md"
							onClick={runImport}
							disabled={busy || (result.imported.length === 0 && attachments.length === 0)}
						>
							{busy ? (
								<>
									<Loader2 className="w-3.5 h-3.5 animate-spin" />
									<Trans>Importing…</Trans>
								</>
							) : result.imported.length > 0 ? (
								<Trans>Import {result.imported.length} items</Trans>
							) : (
								<Plural
									value={attachments.length}
									one="Add # attachment"
									other="Add # attachments"
								/>
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
				passwordLabel={
					kdbxPending.provider.id === "bramble"
						? t`Password for the file`
						: t`KeePass master password`
				}
				allowKeyfile={kdbxPending.provider.id !== "bramble"}
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
						<FilePickerRow
							key={p.id}
							accept={p.accept}
							icon={<span className="text-sm text-primary">{p.label.charAt(0)}</span>}
							title={p.label}
							subtitle={p.blurb}
							trailing={<Upload className="w-4 h-4 text-muted-foreground shrink-0" />}
							onPick={(file) => onFile(p, file)}
						/>
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

/** What the files an import brings will do: go with new items, or join entries already here. */
function AttachmentsLine({ placed }: { placed: PlacedAttachment[] }) {
	const withNew = placed.filter((p) => "item" in p.onto).length;
	const toExisting = placed.length - withNew;
	return (
		<>
			{withNew > 0 && (
				<Plural
					value={withNew}
					one="# attachment goes with them."
					other="# attachments go with them."
				/>
			)}
			{withNew > 0 && toExisting > 0 && " "}
			{toExisting > 0 && (
				<Plural
					value={toExisting}
					one="# attachment will be added to an entry you already have."
					other="# attachments will be added to entries you already have."
				/>
			)}
		</>
	);
}
