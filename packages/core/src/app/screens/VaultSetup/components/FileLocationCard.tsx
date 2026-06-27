import { Trans, useLingui } from "@lingui/react/macro";
import { Check, FileText, FolderOpen, HardDrive } from "lucide-react";
import type { VaultSetupMode } from "../types";

interface FileLocationCardProps {
	hasPicker: boolean;
	hasFile: boolean;
	mode: VaultSetupMode;
	busy: boolean;
	onPick: () => void;
	error: string | null;
}

export function FileLocationCard({
	hasPicker,
	hasFile,
	mode,
	busy,
	onPick,
	error,
}: FileLocationCardProps) {
	return (
		<div className="rounded-lg border border-border/50 bg-card/50 backdrop-blur-sm overflow-hidden mb-4">
			<div className="px-5 py-3 border-b border-border/50">
				<h3 className="text-sm flex items-center gap-2">
					<FolderOpen className="w-4 h-4 text-primary" />
					<Trans>1. Vault file location</Trans>
				</h3>
			</div>
			<div className="p-5 space-y-3">
				<Body hasPicker={hasPicker} hasFile={hasFile} mode={mode} busy={busy} onPick={onPick} />
				{error && <p className="text-xs text-destructive">{error}</p>}
			</div>
		</div>
	);
}

function Body(props: Omit<FileLocationCardProps, "error">) {
	if (!props.hasPicker) return <BrowserStorageFallback />;
	if (props.hasFile) return <FilePicked busy={props.busy} onPick={props.onPick} />;
	return <FileToPick mode={props.mode} busy={props.busy} onPick={props.onPick} />;
}

function FilePicked({ busy, onPick }: { busy: boolean; onPick: () => void }) {
	const { t } = useLingui();
	return (
		<Row
			icon={<Check className="w-4 h-4 text-primary" />}
			title={t`Vault file selected`}
			description={t`Saved to your chosen location (e.g. Dropbox folder).`}
			action={
				<button
					type="button"
					onClick={onPick}
					disabled={busy}
					className="shrink-0 whitespace-nowrap px-3 py-1.5 text-xs rounded-lg border border-border hover:bg-primary/5 hover:border-primary/50 transition-all disabled:opacity-50"
				>
					<Trans>Change</Trans>
				</button>
			}
		/>
	);
}

function FileToPick({
	mode,
	busy,
	onPick,
}: {
	mode: VaultSetupMode;
	busy: boolean;
	onPick: () => void;
}) {
	const { t } = useLingui();
	const isCreate = mode === "create";
	return (
		<Row
			icon={<FileText className="w-4 h-4 text-primary" />}
			title={isCreate ? t`Choose a vault file` : t`Open existing vault file`}
			description={
				isCreate
					? t`Put it in a Dropbox / iCloud / Syncthing folder for cross-device sync.`
					: t`Pick the vault.db file synced from your other device.`
			}
			action={
				<button
					type="button"
					onClick={onPick}
					disabled={busy}
					className="shrink-0 whitespace-nowrap px-4 py-2 text-sm rounded-lg bg-primary text-primary-foreground border border-primary/20 hover:bg-primary/90 transition-all disabled:opacity-50"
				>
					{isCreate ? <Trans>Choose file</Trans> : <Trans>Open file</Trans>}
				</button>
			}
		/>
	);
}

function Row({
	icon,
	title,
	description,
	action,
}: {
	icon: React.ReactNode;
	title: string;
	description: string;
	action?: React.ReactNode;
}) {
	return (
		<div className="flex items-center justify-between gap-3">
			<div className="flex items-start gap-3 min-w-0">
				<div className="flex items-center justify-center w-9 h-9 rounded-lg bg-primary/10 flex-shrink-0">
					{icon}
				</div>
				<div className="min-w-0">
					<p className="text-sm">{title}</p>
					<p className="text-xs text-muted-foreground mt-0.5">{description}</p>
				</div>
			</div>
			{action}
		</div>
	);
}

function BrowserStorageFallback() {
	return (
		<div className="space-y-3">
			<div className="flex items-start gap-3">
				<div className="flex items-center justify-center w-9 h-9 rounded-lg bg-muted flex-shrink-0">
					<HardDrive className="w-4 h-4 text-muted-foreground" />
				</div>
				<div className="min-w-0">
					<p className="text-sm">
						<Trans>Browser storage will be used</Trans>
					</p>
					<p className="text-xs text-muted-foreground mt-0.5">
						<Trans>
							Your browser blocks the file picker here. Your vault will live in extension storage on
							this device only, no cross-device sync.
						</Trans>
					</p>
				</div>
			</div>
			<FsaHelp />
		</div>
	);
}

function FsaHelp() {
	return (
		<div className="rounded-md border border-border/50 bg-muted/30 p-3 text-xs text-muted-foreground space-y-2">
			<p className="text-foreground">
				<Trans>Want sync? Enable the File System Access API in your browser:</Trans>
			</p>
			<ul className="space-y-1 list-disc pl-5">
				<li>
					<Trans>
						<span className="text-foreground">Brave:</span> open{" "}
						<Kbd>brave://flags/#file-system-access-api</Kbd> → set to{" "}
						<span className="text-foreground">Enabled</span> → relaunch. Or set{" "}
						<Kbd>brave://settings/shields</Kbd> fingerprinting blocking to{" "}
						<span className="text-foreground">Standard</span>.
					</Trans>
				</li>
				<li>
					<Trans>
						<span className="text-foreground">Chrome / Edge:</span> usually on by default. If not,
						check <Kbd>chrome://flags/#file-system-access-api</Kbd>.
					</Trans>
				</li>
				<li>
					<Trans>
						<span className="text-foreground">Firefox / Safari:</span> not supported. Use a
						Chromium-based browser for sync.
					</Trans>
				</li>
			</ul>
			<p>
				<Trans>Once enabled, refresh this page and you can choose a vault file location.</Trans>
			</p>
		</div>
	);
}

function Kbd({ children }: { children: React.ReactNode }) {
	return (
		<code className="px-1 py-0.5 rounded bg-background border border-border/50 text-[11px]">
			{children}
		</code>
	);
}
