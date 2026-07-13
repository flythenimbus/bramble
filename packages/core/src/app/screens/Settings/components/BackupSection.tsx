import { Trans, useLingui } from "@lingui/react/macro";
import {
	Boxes,
	ChevronDown,
	ChevronRight,
	Cloud,
	CloudUpload,
	FolderTree,
	HardDrive,
	Mail,
	Plus,
	X,
} from "lucide-react";
import { type ComponentType, useState } from "react";
import {
	type BackupFrequency,
	type BackupTargetConfig,
	normalizeS3,
} from "../../../../backup/config";
import { type SaveTargetInput, useBackup } from "../../../../hooks/useBackup";
import { Backblaze } from "../../../components/icons/Backblaze";
import { CloudflareR2 } from "../../../components/icons/CloudflareR2";
import { Dropbox } from "../../../components/icons/Dropbox";
import { GoogleDrive } from "../../../components/icons/GoogleDrive";
import { NextCloud } from "../../../components/icons/NextCloud";
import { Wasabi } from "../../../components/icons/Wasabi";
import { Modal } from "../../../components/ui/modal";
import { SelectField } from "../../../components/ui/select-field";
import { TextField } from "../../../components/ui/text-field";
import { Section } from "./primitives";

const btnClass =
	"px-3 py-1.5 text-xs rounded-lg border border-border hover:bg-primary/5 hover:border-primary/50 active:scale-[0.98] transition-all disabled:opacity-50";
const primaryBtnClass =
	"w-full px-3 py-2 text-sm rounded-lg bg-primary text-primary-foreground hover:opacity-90 active:scale-[0.98] transition-all disabled:opacity-50";

// s3/webdav fill in credentials; oauth is one-click sign-in (Phase 2, stubbed here).
type Kind = "s3" | "webdav" | "oauth";
type IconComponent = ComponentType<{ className?: string }>;

const isOneClick = (kind: Kind) => kind === "oauth";

interface ProviderDef {
	id: string;
	name: string; // brand name, not localized
	blurb: string; // TODO(i18n): localize provider blurbs once the set settles
	kind: Kind;
	Icon: IconComponent;
	accent: string;
	endpoint?: string;
	region?: string;
	serverUrl?: string;
	needsServerUrl?: boolean;
}

// Popular providers. Brand icons where we have them, lucide placeholders otherwise
// (Storj/pCloud/Fastmail/generic). Endpoints are sensible defaults; verify each
// against the provider's docs. OAuth (Drive/Dropbox) is UI-only here; its sign-in
// flow is Phase 2. See docs/cloud-storage-backups.md.
const PROVIDERS: ProviderDef[] = [
	{
		id: "gdrive",
		name: "Google Drive",
		blurb: "One-click setup",
		kind: "oauth",
		Icon: GoogleDrive,
		accent: "text-amber-500",
	},
	{
		id: "dropbox",
		name: "Dropbox",
		blurb: "One-click setup",
		kind: "oauth",
		Icon: Dropbox,
		accent: "text-blue-500",
	},
	{
		id: "backblaze",
		name: "Backblaze B2",
		blurb: "Cheap, popular backup target",
		kind: "s3",
		Icon: Backblaze,
		accent: "text-red-500",
		endpoint: "https://s3.us-west-002.backblazeb2.com",
		region: "us-west-002",
	},
	{
		id: "r2",
		name: "Cloudflare R2",
		blurb: "No egress fees",
		kind: "s3",
		Icon: CloudflareR2,
		accent: "text-orange-500",
		endpoint: "https://<account-id>.r2.cloudflarestorage.com",
		region: "auto",
	},
	{
		id: "storj",
		name: "Storj",
		blurb: "Decentralized, end-to-end encrypted",
		kind: "s3",
		Icon: Boxes,
		accent: "text-blue-500",
		endpoint: "https://gateway.storjshare.io",
		region: "us-1",
	},
	{
		id: "wasabi",
		name: "Wasabi",
		blurb: "Flat-rate hot storage",
		kind: "s3",
		Icon: Wasabi,
		accent: "text-emerald-500",
		endpoint: "https://s3.wasabisys.com",
		region: "us-east-1",
	},
	{
		id: "s3",
		name: "Other S3-compatible",
		blurb: "MinIO, Ceph, iDrive e2, any S3 API",
		kind: "s3",
		Icon: HardDrive,
		accent: "text-muted-foreground",
	},
	{
		id: "nextcloud",
		name: "Nextcloud",
		blurb: "Self-hosted files",
		kind: "webdav",
		Icon: NextCloud,
		accent: "text-sky-500",
		needsServerUrl: true,
	},
	{
		id: "pcloud",
		name: "pCloud",
		blurb: "Swiss consumer cloud",
		kind: "webdav",
		Icon: Cloud,
		accent: "text-cyan-500",
		serverUrl: "https://webdav.pcloud.com",
	},
	{
		id: "fastmail",
		name: "Fastmail",
		blurb: "Files over WebDAV",
		kind: "webdav",
		Icon: Mail,
		accent: "text-indigo-500",
		serverUrl: "https://webdav.fastmail.com",
	},
	{
		id: "webdav",
		name: "Other WebDAV",
		blurb: "ownCloud, Koofr, any WebDAV",
		kind: "webdav",
		Icon: FolderTree,
		accent: "text-muted-foreground",
		needsServerUrl: true,
	},
];

const providerById = (id: string): ProviderDef | null => PROVIDERS.find((p) => p.id === id) ?? null;

function formatWhen(ms: number): string {
	return new Date(ms).toLocaleString();
}

/** A clickable provider tile: icon badge + name + one-line blurb. */
function ProviderTile({ def, onClick }: { def: ProviderDef; onClick: () => void }) {
	const Icon = def.Icon;
	return (
		<button
			type="button"
			onClick={onClick}
			className="flex items-start gap-2.5 rounded-lg border border-border p-3 text-left hover:border-primary/50 hover:bg-primary/5 active:scale-[0.98] transition-all"
		>
			<div className="flex items-center justify-center w-9 h-9 rounded-lg bg-primary/10 shrink-0">
				<Icon className={`w-4 h-4 ${def.accent}`} />
			</div>
			<div className="min-w-0">
				<p className="text-sm truncate">{def.name}</p>
				<p className="text-xs text-muted-foreground mt-0.5">{def.blurb}</p>
			</div>
		</button>
	);
}

/** The provider picker: one-click providers, then bring-your-own storage. */
function ProviderGrid({ onPick }: { onPick: (def: ProviderDef) => void }) {
	const oneClick = PROVIDERS.filter((p) => isOneClick(p.kind));
	const byo = PROVIDERS.filter((p) => !isOneClick(p.kind));
	return (
		<div className="space-y-3">
			<div className="space-y-1.5">
				<p className="text-xs font-medium text-muted-foreground">
					<Trans>Easiest</Trans>
				</p>
				<div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
					{oneClick.map((p) => (
						<ProviderTile key={p.id} def={p} onClick={() => onPick(p)} />
					))}
				</div>
			</div>
			<div className="space-y-1.5">
				<p className="text-xs font-medium text-muted-foreground">
					<Trans>Bring your own storage</Trans>
				</p>
				<div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
					{byo.map((p) => (
						<ProviderTile key={p.id} def={p} onClick={() => onPick(p)} />
					))}
				</div>
			</div>
		</div>
	);
}

/** Icon + name + blurb + close, shared by both modal variants. */
function ProviderModalHeader({ def, onClose }: { def: ProviderDef; onClose: () => void }) {
	const { t } = useLingui();
	const Icon = def.Icon;
	return (
		<div className="flex items-center gap-3">
			<div className="flex items-center justify-center w-10 h-10 rounded-lg bg-primary/10 shrink-0">
				<Icon className={`w-5 h-5 ${def.accent}`} />
			</div>
			<div className="min-w-0">
				<h2 className="text-base font-medium truncate">{def.name}</h2>
				<p className="text-xs text-muted-foreground truncate">{def.blurb}</p>
			</div>
			<button
				type="button"
				onClick={onClose}
				aria-label={t`Close`}
				className="ml-auto text-muted-foreground hover:text-foreground transition-colors"
			>
				<X className="w-4 h-4" />
			</button>
		</div>
	);
}

/** OAuth modal body. Sign-in is Phase 2, so the action is disabled for now. */
function OneClickComingSoon({ def }: { def: ProviderDef }) {
	const name = def.name;
	return (
		<>
			<p className="text-xs text-muted-foreground">
				<Trans>
					One-click sign-in for {name} is coming in a future update. For now, pick a provider under
					"Bring your own storage".
				</Trans>
			</p>
			<button type="button" disabled className={primaryBtnClass}>
				<Trans>Coming soon</Trans>
			</button>
		</>
	);
}

/** One configured target: icon + name + status, its frequency, and edit/remove. */
function TargetCard({
	target,
	def,
	running,
	onFrequency,
	onEdit,
	onRemove,
}: {
	target: BackupTargetConfig;
	def: ProviderDef;
	running: boolean;
	onFrequency: (f: BackupFrequency) => void;
	onEdit: () => void;
	onRemove: () => void;
}) {
	const { t } = useLingui();
	const Icon = def.Icon;
	const summary = target.provider === "s3" ? target.bucket : target.serverUrl;
	return (
		<div className="rounded-lg border border-border p-3 space-y-3">
			<div className="flex items-start justify-between gap-3">
				<div className="flex min-w-0 items-center gap-3">
					<div className="flex items-center justify-center w-9 h-9 rounded-lg bg-primary/10 shrink-0">
						<Icon className={`w-4 h-4 ${def.accent}`} />
					</div>
					<div className="min-w-0">
						<p className="text-sm truncate">{def.name}</p>
						{running ? (
							<p className="text-xs text-muted-foreground truncate">
								<Trans>Backing up…</Trans>
							</p>
						) : target.lastError ? (
							<p className="text-xs text-red-500 break-words" title={target.lastError}>
								<Trans>Failed</Trans>: {target.lastError}
							</p>
						) : (
							<p className="text-xs text-muted-foreground truncate">
								{target.lastBackupAt ? (
									<Trans>Last backed up {formatWhen(target.lastBackupAt)}</Trans>
								) : summary ? (
									summary
								) : (
									<Trans>Not backed up yet</Trans>
								)}
							</p>
						)}
					</div>
				</div>
				<div className="w-32 shrink-0">
					<SelectField
						label={t`Frequency`}
						value={target.frequency}
						onChange={(e) => onFrequency(e.target.value as BackupFrequency)}
					>
						<option value="off">{t`Off`}</option>
						<option value="daily">{t`Daily`}</option>
						<option value="weekly">{t`Weekly`}</option>
						<option value="monthly">{t`Monthly`}</option>
					</SelectField>
				</div>
			</div>
			<div className="flex items-center gap-3">
				<button type="button" onClick={onEdit} className={btnClass}>
					<Trans>Edit</Trans>
				</button>
				<button
					type="button"
					onClick={onRemove}
					className="text-xs text-muted-foreground hover:text-red-500 transition-colors"
				>
					<Trans>Remove</Trans>
				</button>
			</div>
		</div>
	);
}

type ModalState = { step: "grid" } | { step: "form"; providerId: string; editingId?: string };

/**
 * Cloud backups panel. The vault can have many device-local targets, each on its
 * own frequency; "Back up now" fans out to all of them. S3/WebDAV credentials are
 * VEK-wrapped; OAuth (Drive/Dropbox) is Phase 2. See docs/cloud-storage-backups.md.
 */
export function BackupSection() {
	const { t } = useLingui();
	const backup = useBackup();
	const { targets, runningIds } = backup;

	const [modal, setModal] = useState<ModalState | null>(null);
	const [saving, setSaving] = useState(false);

	// Form fields for the add/edit modal.
	const [endpoint, setEndpoint] = useState("");
	const [region, setRegion] = useState("");
	const [bucket, setBucket] = useState("");
	const [prefix, setPrefix] = useState("");
	const [accessKeyId, setAccessKeyId] = useState("");
	const [secretKey, setSecretKey] = useState("");
	const [serverUrl, setServerUrl] = useState("");
	const [davPath, setDavPath] = useState("");
	const [davUser, setDavUser] = useState("");
	const [davPassword, setDavPassword] = useState("");
	const [advancedOpen, setAdvancedOpen] = useState(false);

	const modalDef = modal?.step === "form" ? providerById(modal.providerId) : null;
	const editing = modal?.step === "form" && Boolean(modal.editingId);

	// Add a fresh provider tile: seed the form from its defaults, revealing Advanced
	// only when there's nothing prefilled to hide.
	const pickProvider = (def: ProviderDef) => {
		setEndpoint(def.endpoint ?? "");
		setRegion(def.region ?? "");
		setBucket("");
		setPrefix("");
		setAccessKeyId("");
		setSecretKey("");
		setServerUrl(def.serverUrl ?? "");
		setDavPath("");
		setDavUser("");
		setDavPassword("");
		setAdvancedOpen(def.kind === "s3" ? !def.endpoint : Boolean(def.needsServerUrl));
		setModal({ step: "form", providerId: def.id });
	};

	// Edit a saved target: prefill non-secret fields; credentials stay blank (we never
	// decrypt secrets back into the DOM), and blank on save keeps them.
	const editTarget = (target: BackupTargetConfig) => {
		const def = providerById(target.providerId);
		if (!def) return;
		setEndpoint(target.endpoint ?? "");
		setRegion(target.region ?? "");
		setBucket(target.bucket ?? "");
		setPrefix(target.prefix ?? "");
		setServerUrl(target.serverUrl ?? "");
		setDavPath(target.path ?? "");
		setAccessKeyId("");
		setSecretKey("");
		setDavUser("");
		setDavPassword("");
		setAdvancedOpen(false);
		setModal({ step: "form", providerId: def.id, editingId: target.id });
	};

	const isS3 = modalDef?.kind === "s3";
	// Accept a full bucket URL pasted into the bucket or endpoint field; split on save.
	const s3Fields = normalizeS3({ endpoint, bucket, prefix });
	const credsFilled = isS3
		? Boolean(accessKeyId.trim() && secretKey.trim())
		: Boolean(davUser.trim() && davPassword.trim());
	const credsTouched = isS3
		? Boolean(accessKeyId.trim() || secretKey.trim())
		: Boolean(davUser.trim() || davPassword.trim());
	// The endpoint must be a real URL, not the R2-style "<account-id>" placeholder.
	const s3EndpointOk = /^https?:\/\//i.test(s3Fields.endpoint) && !s3Fields.endpoint.includes("<");
	const baseFilled = isS3 ? Boolean(s3Fields.bucket) && s3EndpointOk : Boolean(serverUrl.trim());
	const canSave = Boolean(
		modalDef &&
			modalDef.kind !== "oauth" &&
			baseFilled &&
			(editing ? !credsTouched || credsFilled : credsFilled),
	);

	const doSave = async () => {
		if (!modalDef || modalDef.kind === "oauth" || !canSave) return;
		setSaving(true);
		try {
			const input: SaveTargetInput =
				modalDef.kind === "s3"
					? {
							providerId: modalDef.id,
							provider: "s3",
							endpoint: s3Fields.endpoint,
							region: region.trim(),
							bucket: s3Fields.bucket,
							prefix: s3Fields.prefix,
							secrets: credsFilled
								? { accessKeyId: accessKeyId.trim(), secretAccessKey: secretKey.trim() }
								: undefined,
						}
					: {
							providerId: modalDef.id,
							provider: "webdav",
							serverUrl: serverUrl.trim(),
							path: davPath.trim() || undefined,
							secrets: credsFilled
								? { username: davUser.trim(), password: davPassword.trim() }
								: undefined,
						};
			if (modal?.step === "form" && modal.editingId) {
				await backup.updateTarget(modal.editingId, input);
			} else {
				await backup.addTarget(input);
			}
			setModal(null);
		} finally {
			setSaving(false);
		}
	};

	return (
		<Section icon={<CloudUpload className="w-4 h-4 text-primary" />} title={t`Cloud backups`}>
			{targets === undefined ? null : targets.length === 0 ? (
				<>
					<p className="text-sm text-muted-foreground">
						<Trans>
							Choose where to store encrypted backups. Bramble only ever uploads ciphertext, so your
							provider can't read anything in your vault. Add as many as you like.
						</Trans>
					</p>
					<ProviderGrid onPick={pickProvider} />
				</>
			) : (
				<>
					<div className="space-y-2">
						{targets.map((target) => {
							const def = providerById(target.providerId);
							if (!def) return null;
							return (
								<TargetCard
									key={target.id}
									target={target}
									def={def}
									running={runningIds.has(target.id)}
									onFrequency={(f) => void backup.setFrequency(target.id, f)}
									onEdit={() => editTarget(target)}
									onRemove={() => void backup.removeTarget(target.id)}
								/>
							);
						})}
					</div>

					<div className="flex flex-wrap items-center gap-3">
						<button
							type="button"
							onClick={() => setModal({ step: "grid" })}
							className={`${btnClass} inline-flex items-center gap-1.5`}
						>
							<Plus className="w-3.5 h-3.5" />
							<Trans>Add another target</Trans>
						</button>
						<button
							type="button"
							onClick={() => void backup.backupNow().catch(() => {})}
							disabled={runningIds.size > 0}
							className={btnClass}
						>
							<Trans>Back up now</Trans>
						</button>
						{runningIds.size > 0 && (
							<span className="text-xs text-muted-foreground">
								<Trans>Backing up {runningIds.size}…</Trans>
							</span>
						)}
					</div>

					<p className="text-xs text-muted-foreground">
						<Trans>
							Backups are best-effort, not a fixed time. Each target backs up at most as often as
							you pick, the next time you unlock Bramble after one is due, so real frequency depends
							on how often you open it on this device. Unchanged vaults are skipped.
						</Trans>
					</p>
				</>
			)}

			<Modal open={modal !== null} onClose={() => setModal(null)} className="max-w-md">
				{modal?.step === "grid" ? (
					<div className="p-5 space-y-4">
						<div className="flex items-center justify-between">
							<h2 className="text-base font-medium">
								<Trans>Add a backup target</Trans>
							</h2>
							<button
								type="button"
								onClick={() => setModal(null)}
								aria-label={t`Close`}
								className="text-muted-foreground hover:text-foreground transition-colors"
							>
								<X className="w-4 h-4" />
							</button>
						</div>
						<ProviderGrid onPick={pickProvider} />
					</div>
				) : modalDef ? (
					isOneClick(modalDef.kind) ? (
						<div className="p-5 space-y-4">
							<ProviderModalHeader def={modalDef} onClose={() => setModal(null)} />
							<OneClickComingSoon def={modalDef} />
						</div>
					) : (
						<form
							className="p-5 space-y-4"
							onSubmit={(e) => {
								e.preventDefault();
								void doSave();
							}}
						>
							<ProviderModalHeader def={modalDef} onClose={() => setModal(null)} />

							<p className="text-xs text-muted-foreground">
								{modalDef.kind === "s3" ? (
									<Trans>
										Create an access key with read and write access to a bucket, then paste it
										below. For the bucket you can paste its full URL (https://host/bucket).
									</Trans>
								) : (
									<Trans>Enter your WebDAV address and an app password for your account.</Trans>
								)}
							</p>

							{modalDef.kind === "s3" ? (
								<>
									<TextField
										label={t`Bucket`}
										value={bucket}
										onChange={(e) => setBucket(e.target.value)}
									/>
									<TextField
										label={t`Access key ID`}
										value={accessKeyId}
										onChange={(e) => setAccessKeyId(e.target.value)}
									/>
									<TextField
										type="password"
										label={t`Secret access key`}
										value={secretKey}
										onChange={(e) => setSecretKey(e.target.value)}
									/>
								</>
							) : (
								<>
									<TextField
										label={t`Server URL`}
										value={serverUrl}
										onChange={(e) => setServerUrl(e.target.value)}
									/>
									<TextField
										label={t`Username`}
										value={davUser}
										onChange={(e) => setDavUser(e.target.value)}
									/>
									<TextField
										type="password"
										label={t`Password`}
										value={davPassword}
										onChange={(e) => setDavPassword(e.target.value)}
									/>
								</>
							)}

							{editing && (
								<p className="text-xs text-muted-foreground">
									<Trans>Leave the credential fields blank to keep the ones you saved.</Trans>
								</p>
							)}

							<div>
								<button
									type="button"
									onClick={() => setAdvancedOpen((o) => !o)}
									aria-expanded={advancedOpen}
									className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-all"
								>
									{advancedOpen ? (
										<ChevronDown className="w-3.5 h-3.5" />
									) : (
										<ChevronRight className="w-3.5 h-3.5" />
									)}
									<Trans>Advanced</Trans>
								</button>
								{advancedOpen && (
									<div className="mt-3 space-y-4 pl-4 border-l border-border/40">
										{modalDef.kind === "s3" ? (
											<>
												<TextField
													label={t`Endpoint`}
													value={endpoint}
													onChange={(e) => setEndpoint(e.target.value)}
												/>
												<TextField
													label={t`Region`}
													value={region}
													onChange={(e) => setRegion(e.target.value)}
												/>
												<TextField
													label={t`Path prefix (optional)`}
													value={prefix}
													onChange={(e) => setPrefix(e.target.value)}
												/>
											</>
										) : (
											<TextField
												label={t`Path (optional)`}
												value={davPath}
												onChange={(e) => setDavPath(e.target.value)}
											/>
										)}
									</div>
								)}
							</div>

							<div className="flex justify-end gap-2 pt-1">
								<button type="button" onClick={() => setModal(null)} className={btnClass}>
									<Trans>Cancel</Trans>
								</button>
								<button type="submit" disabled={!canSave || saving} className={btnClass}>
									<Trans>Save</Trans>
								</button>
							</div>
						</form>
					)
				) : null}
			</Modal>
		</Section>
	);
}
