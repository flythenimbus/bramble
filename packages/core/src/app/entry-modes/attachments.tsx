import { Trans, useLingui } from "@lingui/react/macro";
import { CloudDownload, ExternalLink, FileLock2, Loader2, Paperclip, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { MAX_ATTACHMENT_BYTES } from "../../backup/archive";
import { useCan, usePlatform } from "../../context/PlatformContext";
import { useVaultActions, useVaultState } from "../../hooks/useVault";
import type { FileRecord } from "../../sync";
import type { FileTransferStatus } from "../../sync/transport/blob-sync";
import {
	AttachmentEntryGoneError,
	AttachmentTooLargeError,
	plaintextSize,
} from "../../vault/file-mutations";
import { Button } from "../components/ui/button";
import { InlineConfirm } from "../components/ui/inline-confirm";
import { usePopOut } from "../hooks/usePopOut";

/**
 * Attachments on one entry. See docs/file-attachments.md.
 *
 * Renders nothing at all when the platform has no file adapter: there would be nowhere to put
 * the bytes, so offering an attach would be offering a write that cannot be read back.
 */
export function AttachmentsDetail({ entryId }: { entryId: string }) {
	const { files, canAttachFiles } = useVaultState();
	const mine = useMemo(() => files.filter((f) => f.entryId === entryId), [files, entryId]);
	// Nothing to poll where the platform has no files: the rows aren't drawn.
	const { held, status } = useArrivals(canAttachFiles ? mine : NO_FILES);
	if (!canAttachFiles) return null;
	return (
		<div className="pt-3 border-t border-border/50 space-y-2">
			<div className="flex items-center gap-1.5 text-xs text-muted-foreground">
				<Paperclip className="w-3.5 h-3.5" />
				<Trans>Attachments</Trans>
			</div>
			{mine.map((record) => (
				<AttachmentRow
					key={record.id}
					record={record}
					held={held.get(record.hash) ?? null}
					status={status[record.hash]}
				/>
			))}
			<AttachButton entryId={entryId} />
		</div>
	);
}

/** `size` is the SEALED length, which overstates the original by one 16-byte tag per 256 KiB
 * chunk (0.006%). Close enough to display, and it avoids storing a second length that could
 * disagree with the bytes actually held. */
function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB"];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

const NO_FILES: FileRecord[] = [];

/** How often an entry with files that have not arrived looks again. Polled rather than pushed
 * because on the extension the transfer runs in another context from this view. */
const ARRIVAL_POLL_MS = 4000;

/**
 * Which of these files this device holds (absent until known), and why each missing one hasn't
 * arrived. Polled while any is missing, with one status request per look for all of them.
 */
function useArrivals(records: FileRecord[]): {
	held: Map<string, boolean>;
	status: Record<string, FileTransferStatus>;
} {
	const { hasFile, fileStatus } = useVaultActions();
	const [held, setHeld] = useState(() => new Map<string, boolean>());
	const [status, setStatus] = useState<Record<string, FileTransferStatus>>({});
	useEffect(() => {
		let live = true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const check = async () => {
			const has = await Promise.all(
				records.map(async (r) => [r.hash, await hasFile(r).catch(() => false)] as const),
			);
			if (!live) return;
			const next = new Map(has);
			setHeld(next);
			const missing = records.filter((r) => !next.get(r.hash)).map((r) => r.hash);
			if (missing.length === 0) return;
			const why = await fileStatus(missing).catch(() => ({}));
			if (!live) return;
			setStatus(why);
			timer = setTimeout(check, ARRIVAL_POLL_MS);
		};
		void check();
		return () => {
			live = false;
			clearTimeout(timer);
		};
	}, [hasFile, fileStatus, records]);
	return { held, status };
}

/** The line under a file that isn't here yet: why, as far as this device's session can tell. */
function ArrivalLine({ status }: { status: FileTransferStatus | undefined }) {
	switch (status?.state) {
		case "downloading": {
			const percent = Math.min(99, Math.floor((status.received / Math.max(status.size, 1)) * 100));
			const from = status.from;
			return from ? (
				<Trans>
					Downloading from {from}, {percent}%
				</Trans>
			) : (
				<Trans>Downloading, {percent}%</Trans>
			);
		}
		case "queued": {
			const from = status.from;
			return from ? (
				<Trans>{from} has it. Coming next.</Trans>
			) : (
				<Trans>A device has it. Coming next.</Trans>
			);
		}
		case "retrying": {
			const from = status.from;
			return from ? (
				<Trans>{from} has it. Trying again shortly.</Trans>
			) : (
				<Trans>A device has it. Trying again shortly.</Trans>
			);
		}
		case "unreachable":
			return <Trans>A device is online but can't connect to this one.</Trans>;
		case "not-on-connected":
			return <Trans>None of your connected devices has it yet.</Trans>;
		case "desktop-only":
			return <Trans>This browser gets files only from the Bramble desktop app.</Trans>;
		default:
			return <Trans>Not on this device yet. Waiting for a device that has it.</Trans>;
	}
}

function AttachmentRow({
	record,
	held,
	status,
}: {
	record: FileRecord;
	held: boolean | null;
	status: FileTransferStatus | undefined;
}) {
	const { detachFile, describeFile, openFile } = useVaultActions();
	const { canOpenFiles } = useVaultState();
	const [opening, setOpening] = useState(false);
	const { t } = useLingui();
	const [name, setName] = useState<string | null>(null);
	const [confirmingRemove, setConfirmingRemove] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// The filename is SEALED, so it has to be decrypted per row rather than read off the record.
	// That is the point of sealing it: a manifest leaked without the VEK names nothing.
	useEffect(() => {
		let live = true;
		describeFile(record)
			.then((meta) => live && setName(meta.name))
			.catch(() => live && setName(null));
		return () => {
			live = false;
		};
	}, [describeFile, record]);

	return (
		<div className="flex items-center gap-2.5 px-3 py-2 rounded-lg border border-border/50 bg-card/40">
			<FileLock2 className="w-4 h-4 text-muted-foreground shrink-0" />
			<div className="min-w-0 flex-1">
				<p className="text-sm truncate">
					{name ?? <span className="text-muted-foreground">{t`Locked`}</span>}
				</p>
				<p className="text-xs text-muted-foreground">{formatSize(plaintextSize(record.size))}</p>
				{held === false && (
					<p className="flex items-center gap-1 text-xs text-muted-foreground mt-0.5">
						<CloudDownload className="w-3.5 h-3.5 shrink-0" />
						<ArrivalLine status={status} />
					</p>
				)}
				{error && <p className="text-xs text-destructive mt-0.5">{error}</p>}
			</div>
			{canOpenFiles && held !== false && !confirmingRemove && (
				<Button
					variant="ghost"
					size="icon"
					disabled={opening || held === null}
					aria-label={t`Open attachment`}
					title={t`Open`}
					onClick={async () => {
						setOpening(true);
						setError(null);
						try {
							await openFile(record);
						} catch (e) {
							setError((e as Error).message);
						} finally {
							setOpening(false);
						}
					}}
				>
					{opening ? (
						<Loader2 className="w-4 h-4 animate-spin" />
					) : (
						<ExternalLink className="w-4 h-4" />
					)}
				</Button>
			)}
			<InlineConfirm
				armed={confirmingRemove}
				onArmedChange={(armed) => {
					setConfirmingRemove(armed);
					if (armed) setError(null);
				}}
				confirmLabel={<Trans>Remove</Trans>}
				busyLabel={<Trans>Removing…</Trans>}
				onConfirm={() => detachFile(record.id)}
				onError={(e) => setError((e as Error).message)}
				trigger={(arm) => (
					<Button
						variant="ghost"
						size="icon"
						aria-label={t`Remove attachment`}
						title={t`Remove`}
						className="hover:bg-destructive/10 hover:text-destructive"
						onClick={arm}
					>
						<Trash2 className="w-4 h-4" />
					</Button>
				)}
			/>
		</div>
	);
}

const LIMIT_MB = Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024));

function AttachButton({ entryId }: { entryId: string }) {
	const { shell } = usePlatform();
	const { attachFile, pickFile } = useVaultActions();
	const { canPickFiles } = useVaultState();
	const { canPopOut, popOut } = usePopOut();
	// Only the attached popup: the detached window it opens is a real window.
	const needsWindow = useCan("filePickerNeedsWindow") && canPopOut;
	const { t } = useLingui();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const attach = async (input: Parameters<typeof attachFile>[0]) => {
		setBusy(true);
		setError(null);
		try {
			await attachFile(input);
		} catch (err) {
			setError(
				err instanceof AttachmentTooLargeError
					? t`Files over ${LIMIT_MB} MB can't be attached.`
					: err instanceof AttachmentEntryGoneError
						? t`This entry was deleted on another device, so the file wasn't attached.`
						: (err as Error).message,
			);
		} finally {
			setBusy(false);
		}
	};

	const label = busy ? (
		<>
			<Loader2 className="w-4 h-4 animate-spin" />
			<Trans>Encrypting…</Trans>
		</>
	) : (
		<>
			<Paperclip className="w-4 h-4" />
			<Trans>Attach a file</Trans>
		</>
	);
	const frame = `flex w-full items-center justify-center gap-2 px-3 py-2 rounded-lg border border-dashed border-border/60 text-sm text-muted-foreground transition-colors ${
		busy ? "opacity-60" : "cursor-pointer hover:border-border hover:text-foreground"
	}`;

	return (
		<div>
			{needsWindow ? (
				// The popup would close under the file picker, so continue in the detached window,
				// on this same entry. Picking there still needs a click: a picker cannot be opened
				// without one.
				<button type="button" className={frame} onClick={() => popOut()}>
					<ExternalLink className="w-4 h-4" />
					<Trans>Popout to window to attach files</Trans>
				</button>
			) : canPickFiles ? (
				// The platform's own dialog: on desktop it yields a path the native side seals from
				// directly, so the file's bytes never cross into the webview.
				<button
					type="button"
					className={frame}
					disabled={busy}
					onClick={async () => {
						shell.notifyFilePickerOpening?.();
						let picked: Awaited<ReturnType<typeof pickFile>>;
						try {
							picked = await pickFile();
						} catch (err) {
							setError((err as Error).message);
							return;
						}
						if (picked) await attach({ ...picked, entryId });
					}}
				>
					{label}
				</button>
			) : (
				<label className={frame}>
					<input
						type="file"
						className="hidden"
						disabled={busy}
						// Keep the vault unlocked while the OS picker backgrounds the app. Without this
						// an "Immediately" auto-lock drops the in-progress attach, and it presents as
						// the app randomly locking rather than as anything to do with files.
						onClick={() => shell.notifyFilePickerOpening?.()}
						onChange={async (e) => {
							const input = e.currentTarget;
							const file = input.files?.[0];
							input.value = ""; // so re-picking the same file fires change again
							if (!file) return;
							await attach({
								source: { kind: "blob", blob: file },
								name: file.name,
								mime: file.type || "application/octet-stream",
								entryId,
							});
						}}
					/>
					{label}
				</label>
			)}
			{error && <p className="text-xs text-destructive mt-1">{error}</p>}
		</div>
	);
}
