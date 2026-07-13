import { Trans, useLingui } from "@lingui/react/macro";
import {
	Boxes,
	CalendarClock,
	ChevronDown,
	ChevronRight,
	Cloud,
	CloudUpload,
	FolderTree,
	HardDrive,
	Mail,
	X,
} from "lucide-react";
import { type ComponentType, useState } from "react";
import type { BackupFrequency } from "../../../../backup/config";
import { useBackup } from "../../../../hooks/useBackup";
import { Backblaze } from "../../../components/icons/Backblaze";
import { CloudflareR2 } from "../../../components/icons/CloudflareR2";
import { Dropbox } from "../../../components/icons/Dropbox";
import { GoogleDrive } from "../../../components/icons/GoogleDrive";
import { NextCloud } from "../../../components/icons/NextCloud";
import { Wasabi } from "../../../components/icons/Wasabi";
import { Modal } from "../../../components/ui/modal";
import { SelectField } from "../../../components/ui/select-field";
import { TextField } from "../../../components/ui/text-field";
import { Row, Section } from "./primitives";

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

function formatWhen(ms: number): string {
	return new Date(ms).toLocaleString();
}

/**
 * Cloud backups panel. Providers are tiles that open a per-kind modal: S3/WebDAV
 * credentials (persisted device-local, credentials VEK-wrapped) or a one-click
 * OAuth connect (Phase 2). "Back up now" uploads immediately. Scheduling is
 * Phase 1. See docs/cloud-storage-backups.md.
 */
export function BackupSection() {
	const { t } = useLingui();
	const backup = useBackup();
	const { config, running } = backup;

	const [modalId, setModalId] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	// Modal form fields (only the ones for the open provider's kind are shown).
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

	const modalDef = modalId ? providerById(modalId) : null;
	const connectedDef = config ? providerById(config.providerId) : null;
	const oneClickProviders = PROVIDERS.filter((p) => isOneClick(p.kind));
	const byoProviders = PROVIDERS.filter((p) => !isOneClick(p.kind));
	// Editing the already-saved provider: blank credential fields keep the saved ones.
	const editing = Boolean(config && modalDef && modalDef.id === config.providerId);

	// Open a provider tile fresh: seed the form from its defaults and reveal
	// Advanced only when there's nothing prefilled to hide (generic or self-hosted).
	const openProvider = (def: ProviderDef) => {
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
		setModalId(def.id);
	};

	// Edit the saved provider: prefill non-secret fields and leave credentials
	// blank (we never decrypt secrets back into the DOM); blank on save keeps them.
	const editProvider = () => {
		if (!config || !connectedDef) return;
		setEndpoint(config.endpoint ?? "");
		setRegion(config.region ?? "");
		setBucket(config.bucket ?? "");
		setPrefix(config.prefix ?? "");
		setServerUrl(config.serverUrl ?? "");
		setDavPath(config.path ?? "");
		setAccessKeyId("");
		setSecretKey("");
		setDavUser("");
		setDavPassword("");
		setAdvancedOpen(false);
		setModalId(connectedDef.id);
	};

	const isS3 = modalDef?.kind === "s3";
	const credsFilled = isS3
		? Boolean(accessKeyId.trim() && secretKey.trim())
		: Boolean(davUser.trim() && davPassword.trim());
	const credsTouched = isS3
		? Boolean(accessKeyId.trim() || secretKey.trim())
		: Boolean(davUser.trim() || davPassword.trim());
	const baseFilled = isS3 ? Boolean(bucket.trim()) : Boolean(serverUrl.trim());
	// New setup needs full credentials; an edit may leave them blank (keep the saved
	// ones), but a half-filled pair is rejected.
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
			// Only send credentials when they were (re-)entered; blank keeps the saved ones.
			await backup.save(
				modalDef.kind === "s3"
					? {
							providerId: modalDef.id,
							provider: "s3",
							endpoint: endpoint.trim(),
							region: region.trim(),
							bucket: bucket.trim(),
							prefix: prefix.trim() || undefined,
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
						},
			);
			setModalId(null);
		} finally {
			setSaving(false);
		}
	};

	return (
		<Section icon={<CloudUpload className="w-4 h-4 text-primary" />} title={t`Cloud backups`}>
			{connectedDef && config ? (
				<>
					<div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
						<div className="flex min-w-0 items-center gap-3">
							<div className="flex items-center justify-center w-9 h-9 rounded-lg bg-primary/10 shrink-0">
								<connectedDef.Icon className={`w-4 h-4 ${connectedDef.accent}`} />
							</div>
							<div className="min-w-0">
								<p className="text-sm truncate">{connectedDef.name}</p>
								<p className="text-xs text-muted-foreground truncate">
									{t`Connected`}
									{config.provider === "s3"
										? config.bucket
											? ` · ${config.bucket}`
											: ""
										: config.serverUrl
											? ` · ${config.serverUrl}`
											: ""}
								</p>
							</div>
						</div>
						<div className="flex shrink-0 items-center gap-2">
							<button type="button" onClick={editProvider} className={btnClass}>
								<Trans>Edit</Trans>
							</button>
							<button
								type="button"
								onClick={() => void backup.remove()}
								className="text-xs text-muted-foreground hover:text-red-500 transition-colors"
							>
								<Trans>Remove</Trans>
							</button>
						</div>
					</div>

					<Row
						icon={<CalendarClock className="w-4 h-4 text-primary" />}
						title={t`Frequency`}
						subtitle={t`How often to back up, at most. Off keeps manual backups only.`}
					>
						<div className="w-40">
							<SelectField
								label={t`Frequency`}
								value={config.frequency}
								onChange={(e) => void backup.setFrequency(e.target.value as BackupFrequency)}
							>
								<option value="off">{t`Off`}</option>
								<option value="daily">{t`Daily`}</option>
								<option value="weekly">{t`Weekly`}</option>
								<option value="monthly">{t`Monthly`}</option>
							</SelectField>
						</div>
					</Row>

					<p className="text-xs text-muted-foreground">
						<Trans>
							Backups are best-effort, not a fixed time. Bramble backs up at most as often as you
							pick here, and only the next time you unlock it after a backup is due, so how often
							backups actually happen depends on how often you open Bramble on this device.
							Unchanged vaults are skipped. Need one right now? Use Back up now.
						</Trans>
					</p>

					<div className="flex flex-wrap items-center gap-3">
						<button
							type="button"
							onClick={() => void backup.backupNow().catch(() => {})}
							disabled={running}
							className={btnClass}
						>
							<Trans>Back up now</Trans>
						</button>
						<span className="text-xs text-muted-foreground">
							{running ? (
								<Trans>Backing up…</Trans>
							) : config.lastError ? (
								<span className="text-red-500">
									<Trans>Backup failed</Trans>: {config.lastError}
								</span>
							) : config.lastBackupAt ? (
								<Trans>Last backed up {formatWhen(config.lastBackupAt)}</Trans>
							) : (
								<Trans>Not backed up yet</Trans>
							)}
						</span>
					</div>
				</>
			) : config === undefined ? null : (
				<>
					<p className="text-sm text-muted-foreground">
						<Trans>
							Choose where to store encrypted backups. Bramble only ever uploads ciphertext, so your
							provider can't read anything in your vault.
						</Trans>
					</p>

					<div className="space-y-1.5">
						<p className="text-xs font-medium text-muted-foreground">
							<Trans>Easiest</Trans>
						</p>
						<div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
							{oneClickProviders.map((prov) => (
								<ProviderTile key={prov.id} def={prov} onClick={() => openProvider(prov)} />
							))}
						</div>
					</div>

					<div className="space-y-1.5">
						<p className="text-xs font-medium text-muted-foreground">
							<Trans>Bring your own storage</Trans>
						</p>
						<div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
							{byoProviders.map((prov) => (
								<ProviderTile key={prov.id} def={prov} onClick={() => openProvider(prov)} />
							))}
						</div>
					</div>
				</>
			)}

			<Modal open={modalDef !== null} onClose={() => setModalId(null)} className="max-w-md">
				{modalDef &&
					(isOneClick(modalDef.kind) ? (
						<div className="p-5 space-y-4">
							<ProviderModalHeader def={modalDef} onClose={() => setModalId(null)} />
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
							<ProviderModalHeader def={modalDef} onClose={() => setModalId(null)} />

							<p className="text-xs text-muted-foreground">
								{modalDef.kind === "s3" ? (
									<Trans>
										Create an access key with read and write access to a bucket, then paste it
										below.
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
								<button type="button" onClick={() => setModalId(null)} className={btnClass}>
									<Trans>Cancel</Trans>
								</button>
								<button type="submit" disabled={!canSave || saving} className={btnClass}>
									<Trans>Save</Trans>
								</button>
							</div>
						</form>
					))}
			</Modal>
		</Section>
	);
}
