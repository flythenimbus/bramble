import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
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
import { isOAuthConfigured, OAUTH_PROVIDERS, type OAuthProviderId } from "../../../../backup/oauth";
import { retryDelayMs } from "../../../../backup/schedule";
import { useAutostart } from "../../../../hooks/useAutostart";
import { type SaveTargetInput, useBackup } from "../../../../hooks/useBackup";
import { usePrefs } from "../../../../hooks/usePrefs";
import { formatDateTime, formatIn } from "../../../../util/format-date";
import { Backblaze } from "../../../components/icons/Backblaze";
import { CloudflareR2 } from "../../../components/icons/CloudflareR2";
import { Dropbox } from "../../../components/icons/Dropbox";
import { NextCloud } from "../../../components/icons/NextCloud";
import { Wasabi } from "../../../components/icons/Wasabi";
import { Button } from "../../../components/ui/button";
import { Modal } from "../../../components/ui/modal";
import { PasswordField } from "../../../components/ui/password-field";
import { SelectField } from "../../../components/ui/select-field";
import { TextField } from "../../../components/ui/text-field";
import { cn } from "../../../components/ui/utils";
import { Section } from "./primitives";

// s3/webdav fill in credentials; oauth is one-click sign-in via shell.connectBackupOAuth.
type Kind = "s3" | "webdav" | "oauth";
type IconComponent = ComponentType<{ className?: string }>;

const isOneClick = (kind: Kind) => kind === "oauth";

// A tile's id maps to a wired OAuth provider only when that provider exists and has a
// real app key configured; otherwise the tile stays "coming soon".
const oauthProviderOf = (providerId: string): OAuthProviderId | null =>
	providerId in OAUTH_PROVIDERS && isOAuthConfigured(providerId as OAuthProviderId)
		? (providerId as OAuthProviderId)
		: null;

/**
 * Where one provider's form copy differs from its kind's default. Message descriptors, not
 * strings: PROVIDERS is module scope, so these translate at render time via `i18n._`.
 */
interface ProviderCopy {
	hint?: MessageDescriptor; // the setup line above the fields
	serverUrlLabel?: MessageDescriptor;
}

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
	copy?: ProviderCopy;
}

// Popular providers. Brand icons where we have them, lucide placeholders otherwise
// (Storj/pCloud/Fastmail/generic). Endpoints are sensible defaults; verify each
// against the provider's docs. Dropbox is the only OAuth tile: it's the one big
// consumer cloud with a true public PKCE client (no secret, no broker). Google Drive
// and OneDrive were evaluated and dropped (see docs/cloud-storage-backups.md);
// everyone else is reachable via the S3 / WebDAV tiles.
const PROVIDERS: ProviderDef[] = [
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
		// "Server URL" invites the Nextcloud root domain, which is not what the field takes.
		copy: {
			hint: msg`Enter your Nextcloud WebDAV address, not the site you sign in to. Files, then Files settings, shows it at the bottom left; it looks like https://cloud.example.com/remote.php/dav/files/USERNAME/. Sign in with an app password, and write the backup folder below as a path, like /path/to/dir.`,
			serverUrlLabel: msg`WebDAV URL`,
		},
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
	return formatDateTime(ms);
}

/** A clickable provider tile: icon badge + name + one-line blurb. */
function ProviderTile({ def, onClick }: { def: ProviderDef; onClick: () => void }) {
	const Icon = def.Icon;
	return (
		<Button
			variant="secondary"
			size="none"
			onClick={onClick}
			className="flex items-start justify-start gap-2.5 p-3 text-left"
		>
			<div className="flex items-center justify-center w-9 h-9 rounded-lg bg-primary/10 shrink-0">
				<Icon className={cn("w-4 h-4", def.accent)} />
			</div>
			<div className="min-w-0">
				<p className="text-sm truncate">{def.name}</p>
				<p className="text-xs text-muted-foreground mt-0.5">{def.blurb}</p>
			</div>
		</Button>
	);
}

// The generic "Other ..." catch-all tiles sort last, after the named brands.
const GENERIC_IDS = new Set(["s3", "webdav"]);

/** The provider picker: named brands alphabetically, then the generic catch-alls. */
function ProviderGrid({ onPick }: { onPick: (def: ProviderDef) => void }) {
	const providers = [...PROVIDERS].sort((a, b) => {
		const ga = GENERIC_IDS.has(a.id);
		const gb = GENERIC_IDS.has(b.id);
		if (ga !== gb) return ga ? 1 : -1;
		return a.name.localeCompare(b.name);
	});
	return (
		<div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
			{providers.map((p) => (
				<ProviderTile key={p.id} def={p} onClick={() => onPick(p)} />
			))}
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
				<Icon className={cn("w-5 h-5", def.accent)} />
			</div>
			<div className="min-w-0">
				<h2 className="text-base font-medium truncate">{def.name}</h2>
				<p className="text-xs text-muted-foreground truncate">{def.blurb}</p>
			</div>
			<Button
				variant="link"
				size="none"
				onClick={onClose}
				aria-label={t`Close`}
				className="ml-auto transition-colors"
			>
				<X className="w-4 h-4" />
			</Button>
		</div>
	);
}

/** The setup line above the credential fields: the tile's own copy, else its kind's. */
function SetupHint({ def }: { def: ProviderDef }) {
	const { i18n } = useLingui();
	if (def.copy?.hint) return <>{i18n._(def.copy.hint)}</>;
	if (def.kind === "s3")
		return (
			<Trans>
				Create an access key with read and write access to a bucket, then paste it below. For the
				bucket you can paste its full URL (https://host/bucket).
			</Trans>
		);
	return <Trans>Enter your WebDAV address and an app password for your account.</Trans>;
}

/**
 * OAuth modal body. When the platform can run the flow and the provider is wired, it
 * offers a "Connect" button that signs in and adds the target; otherwise it falls back
 * to the "coming soon" note (mobile, or a build with no app key configured).
 */
function OneClickPanel({
	def,
	available,
	onConnect,
	onClose,
}: {
	def: ProviderDef;
	available: boolean;
	onConnect: () => Promise<void>;
	onClose: () => void;
}) {
	const [connecting, setConnecting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const name = def.name;

	if (!available) {
		return (
			<>
				<p className="text-xs text-muted-foreground">
					<Trans>
						One-click sign-in for {name} is coming in a future update. For now, pick a provider
						under "Bring your own storage".
					</Trans>
				</p>
				<Button variant="primary" size="none" fullWidth disabled className="px-3 py-2 text-sm">
					<Trans>Coming soon</Trans>
				</Button>
			</>
		);
	}

	const connect = async () => {
		setError(null);
		setConnecting(true);
		try {
			await onConnect();
			onClose();
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setConnecting(false);
		}
	};

	return (
		<>
			<p className="text-xs text-muted-foreground">
				<Trans>
					Sign in and Bramble stores encrypted backups in its own {name} app folder. Only ciphertext
					is uploaded, so {name} can't read anything in your vault.
				</Trans>
			</p>
			{error && (
				<p className="text-xs text-red-500 break-words" title={error}>
					{error}
				</p>
			)}
			<Button
				variant="primary"
				size="none"
				fullWidth
				onClick={() => void connect()}
				disabled={connecting}
				className="px-3 py-2 text-sm"
			>
				{connecting ? <Trans>Connecting…</Trans> : <Trans>Connect {name}</Trans>}
			</Button>
		</>
	);
}

/** One configured target: icon + name + status, its frequency, and edit/remove. */
function TargetCard({
	target,
	def,
	running,
	folder,
	whileLocked,
	onFrequency,
	onEdit,
	onReconnect,
	onRemove,
}: {
	target: BackupTargetConfig;
	def: ProviderDef;
	running: boolean;
	// The folder THIS vault's snapshots land in, shown only when several vaults exist: a target
	// carried over from the old shared config writes to a derived folder, not the one in its form.
	folder?: string;
	// Whether this target's schedule is kept while the vault is locked. Undefined on the platforms
	// where the answer is always "no" and saying so would be noise (the extension, mobile).
	whileLocked?: boolean;
	onFrequency: (f: BackupFrequency) => void;
	onEdit: () => void;
	// Present for OAuth targets: re-run sign-in in place instead of editing credential fields.
	onReconnect?: () => void;
	onRemove: () => void;
}) {
	const { t } = useLingui();
	const Icon = def.Icon;
	const summary =
		target.provider === "s3"
			? target.bucket
			: target.provider === "webdav"
				? target.serverUrl
				: target.path || def.name;
	// How long this target is still backing off, so a failure says when it will be tried again
	// rather than looking abandoned. Read at render: it goes stale in an open panel, and a
	// countdown that ticks is not worth a timer here. Undefined once the wait is over, and for a
	// target that is off (it has no next attempt) or whose backoff an edit already cleared.
	const retryIn =
		target.frequency !== "off" && target.failedAt && target.failures
			? target.failedAt + retryDelayMs(target.failures, target.frequency) - Date.now()
			: undefined;
	return (
		<div className="rounded-lg border border-border p-3 space-y-3">
			<div className="flex items-start justify-between gap-3">
				<div className="flex min-w-0 items-center gap-3">
					<div className="flex items-center justify-center w-9 h-9 rounded-lg bg-primary/10 shrink-0">
						<Icon className={cn("w-4 h-4", def.accent)} />
					</div>
					<div className="min-w-0">
						<p className="text-sm truncate">{def.name}</p>
						{running ? (
							<p className="text-xs text-muted-foreground truncate">
								<Trans>Backing up…</Trans>
							</p>
						) : target.lastError ? (
							<>
								<p className="text-xs text-red-500 break-words" title={target.lastError}>
									<Trans>Failed</Trans>: {target.lastError}
								</p>
								{retryIn !== undefined && retryIn > 0 && (
									<p className="text-xs text-muted-foreground truncate">
										<Trans>Next attempt {formatIn(retryIn)}</Trans>
									</p>
								)}
							</>
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
						{folder && (
							<p className="text-xs text-muted-foreground truncate" title={folder}>
								<Trans>This vault's folder: {folder}</Trans>
							</p>
						)}
						{/* Behaviour, not mechanism: where the credential lives is our decision, and naming
						    the store would only invite a judgement nobody can make from here. */}
						{whileLocked !== undefined && (
							<p className="text-xs text-muted-foreground truncate">
								{whileLocked ? (
									<Trans>Backs up on schedule</Trans>
								) : (
									<Trans>Backs up when you unlock this vault</Trans>
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
				{onReconnect ? (
					<Button variant="secondary" size="sm" onClick={onReconnect}>
						<Trans>Reconnect</Trans>
					</Button>
				) : (
					<Button variant="secondary" size="sm" onClick={onEdit}>
						<Trans>Edit</Trans>
					</Button>
				)}
				<Button
					variant="link"
					size="none"
					onClick={onRemove}
					className="text-xs hover:text-red-500 transition-colors"
				>
					<Trans>Remove</Trans>
				</Button>
			</div>
		</div>
	);
}

type ModalState = { step: "grid" } | { step: "form"; providerId: string; editingId?: string };

/**
 * Cloud backups panel. The vault can have many device-local targets, each on its
 * own frequency; "Back up now" fans out to all of them. S3/WebDAV credentials are
 * VEK-wrapped; OAuth providers store a refresh token instead. See docs/cloud-storage-backups.md.
 */
export function BackupSection() {
	const { t, i18n } = useLingui();
	const backup = useBackup();
	const { targets, runningIds } = backup;
	// Desktop only; absent everywhere else, which hides the prompt below without a target check.
	const autostart = useAutostart();
	const { prefs, update } = usePrefs();

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
	const [keep, setKeep] = useState(30);
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
		setKeep(30);
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
		setKeep(target.keep ?? 30);
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
							keep,
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
							keep,
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
			{backup.multiVault && (
				<p className="text-xs text-muted-foreground">
					<Trans>
						These destinations belong to the vault you're in. Every vault keeps its own targets and
						its own backup folder.
					</Trans>
				</p>
			)}
			{/* Desktop only, and the thing a first-time backup setup most needs to hear: the schedule
			    is kept by this process, so an app that never starts is an app that never backs up.
			    Shown while a target is actually scheduled, so it is an explanation rather than an
			    advert, and dismissible because leaving the machine on is a perfectly good reason to
			    decline. */}
			{autostart.available &&
				autostart.enabled === false &&
				!prefs.autostartPromptDismissed &&
				targets?.some((target) => target.frequency !== "off") && (
					<div className="rounded-lg border border-border bg-muted/40 p-3 space-y-2">
						<p className="text-xs">
							<Trans>
								Scheduled backups only run while Bramble is running. Start it at login and they
								happen on their own, from the menu bar, without you opening the app.
							</Trans>
						</p>
						<div className="flex flex-wrap items-center gap-2">
							<Button size="sm" onClick={() => void autostart.setEnabled(true)}>
								<Trans>Start at login</Trans>
							</Button>
							<Button
								variant="secondary"
								size="sm"
								onClick={() => void update("autostartPromptDismissed", true)}
							>
								<Trans>Not now</Trans>
							</Button>
						</div>
						{autostart.error && <p className="text-xs text-red-500">{autostart.error}</p>}
					</div>
				)}
			{/* A remedy, not a warning: this is one package away for almost everyone who sees it, and
			    the alternative is backups that quietly only happen when the vault is open. */}
			{backup.noStore && (
				<p className="text-xs text-muted-foreground">
					<Trans>
						Backups on this computer run when you unlock a vault, because this session has no
						keyring to keep the connection details in. Starting GNOME Keyring or KWallet, or turning
						on KeePassXC's Secret Service integration, lets them run on schedule instead.
					</Trans>
				</p>
			)}
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
							const oauthId = oauthProviderOf(def.id);
							return (
								<TargetCard
									key={target.id}
									target={target}
									def={def}
									running={runningIds.has(target.id)}
									folder={backup.multiVault ? backup.folderFor(target) : undefined}
									// Only where a schedule can be kept at all is the distinction worth drawing.
									whileLocked={
										backup.unattended || backup.noStore ? backup.runsWhileLocked(target) : undefined
									}
									onFrequency={(f) => void backup.setFrequency(target.id, f)}
									onEdit={() => editTarget(target)}
									onReconnect={
										oauthId
											? () =>
													void backup.connectOAuth(oauthId, { targetId: target.id }).catch(() => {})
											: undefined
									}
									onRemove={() => void backup.removeTarget(target.id)}
								/>
							);
						})}
					</div>

					<div className="flex flex-wrap items-center gap-3">
						<Button
							variant="secondary"
							size="sm"
							onClick={() => setModal({ step: "grid" })}
							className="gap-1.5"
						>
							<Plus className="w-3.5 h-3.5" />
							<Trans>Add another target</Trans>
						</Button>
						<Button
							variant="secondary"
							size="sm"
							onClick={() => void backup.backupNow().catch(() => {})}
							disabled={runningIds.size > 0}
						>
							<Trans>Back up now</Trans>
						</Button>
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
							<Button
								variant="link"
								size="none"
								onClick={() => setModal(null)}
								aria-label={t`Close`}
								className="transition-colors"
							>
								<X className="w-4 h-4" />
							</Button>
						</div>
						<ProviderGrid onPick={pickProvider} />
					</div>
				) : modalDef ? (
					isOneClick(modalDef.kind) ? (
						<div className="p-5 space-y-4">
							<ProviderModalHeader def={modalDef} onClose={() => setModal(null)} />
							<OneClickPanel
								def={modalDef}
								available={backup.oauthAvailable && oauthProviderOf(modalDef.id) !== null}
								onConnect={async () => {
									const id = oauthProviderOf(modalDef.id);
									if (id) await backup.connectOAuth(id);
								}}
								onClose={() => setModal(null)}
							/>
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
								<SetupHint def={modalDef} />
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
									<PasswordField
										label={t`Secret access key`}
										value={secretKey}
										onChange={(e) => setSecretKey(e.target.value)}
									/>
								</>
							) : (
								<>
									<TextField
										label={
											modalDef.copy?.serverUrlLabel
												? i18n._(modalDef.copy.serverUrlLabel)
												: t`Server URL`
										}
										value={serverUrl}
										onChange={(e) => setServerUrl(e.target.value)}
									/>
									<TextField
										label={t`Username`}
										value={davUser}
										onChange={(e) => setDavUser(e.target.value)}
									/>
									<PasswordField
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
								<Button
									variant="link"
									size="none"
									onClick={() => setAdvancedOpen((o) => !o)}
									aria-expanded={advancedOpen}
									className="gap-1.5 text-xs"
								>
									{advancedOpen ? (
										<ChevronDown className="w-3.5 h-3.5" />
									) : (
										<ChevronRight className="w-3.5 h-3.5" />
									)}
									<Trans>Advanced</Trans>
								</Button>
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
												label={t`Backup folder (optional)`}
												value={davPath}
												onChange={(e) => setDavPath(e.target.value)}
											/>
										)}
										<SelectField
											label={t`Backups to keep`}
											value={String(keep)}
											onChange={(e) => setKeep(Number(e.target.value))}
										>
											<option value="5">{t`Last 5`}</option>
											<option value="10">{t`Last 10`}</option>
											<option value="30">{t`Last 30`}</option>
											<option value="100">{t`Last 100`}</option>
										</SelectField>
									</div>
								)}
							</div>

							<div className="flex justify-end gap-2 pt-1">
								<Button variant="secondary" size="sm" onClick={() => setModal(null)}>
									<Trans>Cancel</Trans>
								</Button>
								<Button type="submit" variant="secondary" size="sm" disabled={!canSave || saving}>
									<Trans>Save</Trans>
								</Button>
							</div>
						</form>
					)
				) : null}
			</Modal>
		</Section>
	);
}
