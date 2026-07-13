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
	"w-full px-3 py-2 text-sm rounded-lg bg-primary text-primary-foreground hover:opacity-90 active:scale-[0.98] transition-all";

// s3/webdav fill in credentials; oauth is one-click sign-in.
type Kind = "s3" | "webdav" | "oauth";
type Frequency = "off" | "daily" | "weekly" | "monthly";
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
// (Storj/pCloud/Fastmail/generic). Endpoints are sensible defaults for this preview;
// verify each against the provider's docs before wiring. OAuth (Drive/Dropbox) is
// UI-only here; its sign-in flow is Phase 2. See docs/cloud-storage-backups.md.
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

/** One-click modal body: an explanation and a single Connect button (no fields). */
function OneClickConnect({ def, onConnect }: { def: ProviderDef; onConnect: () => void }) {
	const name = def.name;
	return (
		<>
			<p className="text-xs text-muted-foreground">
				<Trans>
					You'll sign in to {name} in a new window and let Bramble upload encrypted backups to your
					account. Bramble only ever uploads ciphertext.
				</Trans>
			</p>
			<button type="button" onClick={onConnect} className={primaryBtnClass}>
				<Trans>Connect {name}</Trans>
			</button>
		</>
	);
}

/**
 * Cloud backups panel. UI only for now: local state, no persistence and no
 * upload. Providers are tiles that open a per-kind modal: credentials for
 * S3/WebDAV, a one-click connect for OAuth (Drive/Dropbox). Those flows are
 * wired in Phase 2. See docs/cloud-storage-backups.md.
 */
export function BackupSection() {
	const { t } = useLingui();
	const [connected, setConnected] = useState<{ def: ProviderDef; summary: string } | null>(null);
	const [modalId, setModalId] = useState<string | null>(null);
	const [frequency, setFrequency] = useState<Frequency>("daily");

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

	const modalDef = modalId ? (PROVIDERS.find((p) => p.id === modalId) ?? null) : null;
	const oneClickProviders = PROVIDERS.filter((p) => isOneClick(p.kind));
	const byoProviders = PROVIDERS.filter((p) => !isOneClick(p.kind));

	// Open a provider tile: seed the form from its defaults, and reveal Advanced
	// only when there's nothing prefilled to hide (generic or self-hosted).
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

	const canSave = modalDef
		? modalDef.kind === "s3"
			? Boolean(bucket.trim() && accessKeyId.trim() && secretKey.trim())
			: Boolean(serverUrl.trim() && davUser.trim() && davPassword.trim())
		: false;

	const save = () => {
		if (!modalDef || !canSave) return;
		const summary = modalDef.kind === "s3" ? bucket.trim() : serverUrl.trim();
		setConnected({ def: modalDef, summary });
		setModalId(null);
	};

	return (
		<Section icon={<CloudUpload className="w-4 h-4 text-primary" />} title={t`Cloud backups`}>
			{connected ? (
				<>
					<div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
						<div className="flex min-w-0 items-center gap-3">
							<div className="flex items-center justify-center w-9 h-9 rounded-lg bg-primary/10 shrink-0">
								<connected.def.Icon className={`w-4 h-4 ${connected.def.accent}`} />
							</div>
							<div className="min-w-0">
								<p className="text-sm truncate">{connected.def.name}</p>
								<p className="text-xs text-muted-foreground truncate">
									{t`Connected`}
									{connected.summary ? ` · ${connected.summary}` : ""}
								</p>
							</div>
						</div>
						<div className="flex shrink-0 items-center gap-2">
							<button
								type="button"
								onClick={() => setModalId(connected.def.id)}
								className={btnClass}
							>
								<Trans>Edit</Trans>
							</button>
							<button
								type="button"
								onClick={() => setConnected(null)}
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
								value={frequency}
								onChange={(e) => setFrequency(e.target.value as Frequency)}
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
						<button type="button" className={btnClass}>
							<Trans>Back up now</Trans>
						</button>
						<span className="text-xs text-muted-foreground">
							<Trans>Last backed up: never</Trans>
						</span>
					</div>
				</>
			) : (
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
							<OneClickConnect
								def={modalDef}
								onConnect={() => {
									setConnected({ def: modalDef, summary: "" });
									setModalId(null);
								}}
							/>
						</div>
					) : (
						<form
							className="p-5 space-y-4"
							onSubmit={(e) => {
								e.preventDefault();
								save();
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
								<button type="submit" disabled={!canSave} className={btnClass}>
									<Trans>Save</Trans>
								</button>
							</div>
						</form>
					))}
			</Modal>
		</Section>
	);
}
