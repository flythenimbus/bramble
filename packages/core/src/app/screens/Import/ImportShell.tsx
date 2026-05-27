import { ArrowLeft, Check, Database, Loader2, ShieldCheck, Upload } from "lucide-react";
import { useState } from "react";
import { usePlatform } from "../../../context/PlatformContext";
import { useVault } from "../../../hooks/useVault";
import {
	IMPORT_PROVIDERS,
	type ImportProviderInfo,
	type ImportResult,
	parseImport,
} from "../../../import";
import { TextField } from "../../components/ui/text-field";
import { getEntryMode } from "../../entry-modes";

const MAX_IMPORT_FILE_MB = 50;
const MAX_IMPORT_FILE_BYTES = MAX_IMPORT_FILE_MB * 1024 * 1024;

// Page chrome shared by every state.
function Shell({ children }: { children: React.ReactNode }) {
	return (
		<div className="min-h-screen bg-gradient-to-br from-background via-background to-primary/5 flex items-center justify-center p-6">
			<div className="w-full max-w-xl">{children}</div>
		</div>
	);
}

function Header({ subtitle }: { subtitle: string }) {
	return (
		<div className="text-center mb-6">
			<div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-gradient-to-br from-primary to-primary/80 mb-3">
				<Database className="w-7 h-7 text-primary-foreground" />
			</div>
			<h1 className="text-2xl">Import data</h1>
			<p className="text-sm text-muted-foreground mt-1">{subtitle}</p>
		</div>
	);
}

// Pluralized "3 Logins" / "1 Payment card" line from the per-type counts.
function countLine(result: ImportResult): string {
	const parts = Object.entries(result.byType).map(([type, n]) => {
		const label = getEntryMode(type).label;
		return `${n} ${label}${n === 1 ? "" : "s"}`;
	});
	return parts.join(" · ");
}

function UnlockGate({ onUnlock }: { onUnlock: (pw: string) => Promise<void> }) {
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		setError(null);
		setBusy(true);
		try {
			await onUnlock(password);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Couldn't unlock the vault.");
		} finally {
			setBusy(false);
		}
	};

	return (
		<Shell>
			<Header subtitle="Unlock your vault to import into it" />
			<form
				onSubmit={submit}
				className="rounded-lg border border-border/50 bg-card/50 backdrop-blur-sm p-6 space-y-4"
			>
				<TextField
					label="Master password"
					type="password"
					autoComplete="current-password"
					autoFocus
					value={password}
					onChange={(e) => setPassword(e.target.value)}
					error={error ?? undefined}
				/>
				<button
					type="submit"
					disabled={busy || !password}
					className="w-full px-5 py-2.5 text-sm rounded-lg bg-primary text-primary-foreground border border-primary/20 hover:bg-primary/90 active:scale-[0.98] transition-all disabled:opacity-50"
				>
					{busy ? "Unlocking…" : "Unlock"}
				</button>
			</form>
		</Shell>
	);
}

export function ImportShell() {
	const { ready, hasVault, isLocked, unlock, importEntries } = useVault();
	const { shell } = usePlatform();
	const [provider, setProvider] = useState<ImportProviderInfo | null>(null);
	const [result, setResult] = useState<ImportResult | null>(null);
	const [imported, setImported] = useState<number | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	if (!ready) {
		return (
			<Shell>
				<div className="flex justify-center py-12">
					<Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
				</div>
			</Shell>
		);
	}

	if (!hasVault) {
		return (
			<Shell>
				<Header subtitle="You need a vault before you can import into it" />
				<div className="rounded-lg border border-border/50 bg-card/50 backdrop-blur-sm p-6 text-center space-y-4">
					<p className="text-sm text-muted-foreground">
						Set up your {shell.appName} vault first, then come back to import.
					</p>
					<button
						type="button"
						onClick={() => window.location.assign(window.location.pathname)}
						className="px-5 py-2.5 text-sm rounded-lg bg-primary text-primary-foreground border border-primary/20 hover:bg-primary/90 active:scale-[0.98] transition-all"
					>
						Set up a vault
					</button>
				</div>
			</Shell>
		);
	}

	if (isLocked) return <UnlockGate onUnlock={unlock} />;

	if (imported !== null) {
		return (
			<Shell>
				<div className="rounded-lg border border-border/50 bg-card/50 backdrop-blur-sm p-8 text-center space-y-3">
					<div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-gradient-to-br from-primary to-primary/80">
						<Check className="w-7 h-7 text-primary-foreground" />
					</div>
					<h1 className="text-2xl">Imported {imported} items</h1>
					<p className="text-sm text-muted-foreground">
						They're in your vault now. For your safety, delete the export file you just imported —
						it holds your passwords in plain text.
					</p>
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
				setError(
					`This file is too large to import (${(file.size / 1024 / 1024).toFixed(1)} MB; max ${MAX_IMPORT_FILE_MB} MB).`,
				);
				return;
			}
			const raw = p.reads === "text" ? await file.text() : new Uint8Array(await file.arrayBuffer());
			const res = parseImport(p.id, raw);
			if (res.imported.length === 0) {
				setError(
					res.skipped > 0
						? `This file held ${res.skipped} item${res.skipped === 1 ? "" : "s"}, but none matched a supported format.`
						: "No importable items were found in this file.",
				);
				return;
			}
			setProvider(p);
			setResult(res);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Couldn't read this file.");
		} finally {
			setBusy(false);
		}
	};

	const runImport = async () => {
		if (!result) return;
		setBusy(true);
		setError(null);
		try {
			await importEntries(result.imported);
			setImported(result.imported.length);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Couldn't write to the vault.");
		} finally {
			setBusy(false);
		}
	};

	if (result && provider) {
		return (
			<Shell>
				<Header subtitle={`Review what we found in your ${provider.label} export`} />
				<div className="rounded-lg border border-border/50 bg-card/50 backdrop-blur-sm overflow-hidden">
					<div className="p-4 space-y-3">
						<div className="flex items-center gap-2.5">
							<ShieldCheck className="w-5 h-5 text-primary shrink-0" />
							<p className="text-sm">
								<span className="text-base">{result.imported.length}</span> items ready to import
							</p>
						</div>
						<p className="text-xs text-muted-foreground">{countLine(result)}</p>
						{result.warnings.length > 0 && (
							<ul className="text-xs text-yellow-500 space-y-1 list-disc pl-4">
								{result.warnings.slice(0, 8).map((w) => (
									<li key={w}>{w}</li>
								))}
								{result.warnings.length > 8 && <li>…and {result.warnings.length - 8} more</li>}
							</ul>
						)}
						{error && <p className="text-xs text-destructive">{error}</p>}
					</div>
					<div className="p-4 bg-muted/30 border-t border-border/50 flex items-center justify-between gap-3">
						<button
							type="button"
							onClick={() => {
								setResult(null);
								setProvider(null);
								setError(null);
							}}
							disabled={busy}
							className="flex items-center gap-2 px-4 py-2 text-sm rounded-lg border border-border hover:bg-background/50 active:scale-[0.98] transition-all disabled:opacity-50"
						>
							<ArrowLeft className="w-3.5 h-3.5" />
							Choose another file
						</button>
						<button
							type="button"
							onClick={runImport}
							disabled={busy}
							className="flex items-center gap-2 px-5 py-2 text-sm rounded-lg bg-primary text-primary-foreground border border-primary/20 hover:bg-primary/90 active:scale-[0.98] transition-all disabled:opacity-50"
						>
							{busy ? (
								<>
									<Loader2 className="w-3.5 h-3.5 animate-spin" />
									Importing…
								</>
							) : (
								`Import ${result.imported.length} items`
							)}
						</button>
					</div>
				</div>
			</Shell>
		);
	}

	return (
		<Shell>
			<Header subtitle="Bring your logins, cards and notes over from another manager" />
			<div className="space-y-2.5">
				{IMPORT_PROVIDERS.map((p) => (
					<label
						key={p.id}
						className="flex items-center gap-3 p-4 rounded-lg border border-border/50 bg-card/50 backdrop-blur-sm cursor-pointer hover:border-border hover:bg-card/80 active:scale-[0.99] transition-all"
					>
						<input
							type="file"
							accept={p.accept}
							className="hidden"
							onChange={(e) => {
								const input = e.currentTarget;
								void onFile(p, input.files?.[0]).finally(() => {
									input.value = "";
								});
							}}
						/>
						<div className="flex items-center justify-center w-10 h-10 rounded-lg bg-gradient-to-br from-primary/20 to-primary/10 shrink-0">
							<span className="text-sm text-primary">{p.label.charAt(0)}</span>
						</div>
						<div className="min-w-0 flex-1">
							<p className="text-sm">{p.label}</p>
							<p className="text-xs text-muted-foreground truncate">{p.blurb}</p>
						</div>
						<Upload className="w-4 h-4 text-muted-foreground shrink-0" />
					</label>
				))}
			</div>
			{busy && (
				<div className="flex items-center justify-center gap-2 mt-4 text-sm text-muted-foreground">
					<Loader2 className="w-4 h-4 animate-spin" />
					Reading file…
				</div>
			)}
			{error && <p className="text-sm text-destructive text-center mt-4">{error}</p>}
			<p className="text-xs text-muted-foreground text-center mt-6">
				Files are read on this device only — nothing is uploaded. Delete the export file once you're
				done.
			</p>
		</Shell>
	);
}
