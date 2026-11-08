import { Trans, useLingui } from "@lingui/react/macro";
import { GitMerge } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { usePlatform } from "../../../context/PlatformContext";
import {
	ConflictChangedError,
	type ConflictChoice,
	type ConflictVersion,
	type Entry,
	type EntryData,
} from "../../../hooks/useVault";
import type { EntryConflict } from "../../../sync";
import { formatDateTime } from "../../../util/format-date";
import { Button } from "../../components/ui/button";
import { getEntryMode } from "../../entry-modes";
import { CustomFieldsDetail } from "../../entry-modes/custom-fields";

interface ConflictBannerProps {
	/** The displayed version. */
	entry: Entry;
	conflict: EntryConflict;
	/** The sibling versions, decrypted on demand. */
	onReadVersions: () => Promise<ConflictVersion[]>;
	onResolve: (choice: ConflictChoice) => Promise<void>;
	onDelete: () => Promise<void>;
}

/** Credential ids of a version's passkeys. */
const passkeyIds = (e: EntryData) =>
	new Set((e.type === "login" ? (e.passkeys ?? []) : []).map((p) => p.credentialId));

/**
 * Sync kept more than one version of this entry, or a delete nobody's edit saw, and the user
 * chooses. See docs/sync-conflicts.md.
 */
export function ConflictBanner({
	entry,
	conflict,
	onReadVersions,
	onResolve,
	onDelete,
}: ConflictBannerProps) {
	const { t } = useLingui();
	const [open, setOpen] = useState(false);
	const [versions, setVersions] = useState<ConflictVersion[] | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// Held in a ref: callers pass a fresh closure every render, which must not refire the load.
	const read = useRef(onReadVersions);
	read.current = onReadVersions;

	// A sync can change the versions while the user compares, so keep what's shown current.
	// biome-ignore lint/correctness/useExhaustiveDependencies: conflict/entry are the reload triggers
	useEffect(() => {
		if (!open) return;
		let live = true;
		void read.current().then((v) => {
			if (live) setVersions(v);
		});
		return () => {
			live = false;
		};
	}, [open, conflict, entry]);

	const run = async (action: () => Promise<void>) => {
		setBusy(true);
		setError(null);
		try {
			await action();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			if (e instanceof ConflictChangedError && open) setVersions(await read.current());
		} finally {
			setBusy(false);
		}
	};
	// The siblings the user is looking at; a resolution refuses if these changed underneath.
	const seen = versions?.map((v) => v.hlc) ?? [];
	const deleteButton = (
		<Button variant="destructive" size="sm" disabled={busy} onClick={() => void run(onDelete)}>
			<Trans>Delete it</Trans>
		</Button>
	);
	// What a sibling has that the masked, mode-specific body can't show.
	const differences = (other: EntryData): string[] => {
		const notes: string[] = [];
		if (entry.type === "login" && other.type === "login" && entry.password !== other.password) {
			notes.push(t`Its password is different from the version shown.`);
		}
		const shownKeys = passkeyIds(entry);
		const extra = [...passkeyIds(other)].filter((id) => !shownKeys.has(id)).length;
		if (extra === 1) notes.push(t`It holds a passkey the version shown doesn't.`);
		else if (extra > 1) notes.push(t`It holds ${extra} passkeys the version shown doesn't.`);
		return notes;
	};
	const othersKeys = new Set(versions?.flatMap((v) => [...passkeyIds(v.data)]) ?? []);
	const shownOnly = [...passkeyIds(entry)].filter((id) => !othersKeys.has(id)).length;

	return (
		<div className="mb-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-sm">
			<div className="flex items-start gap-2.5">
				<GitMerge className="w-4 h-4 mt-0.5 shrink-0 text-warning" />
				<div className="min-w-0 flex-1 space-y-1">
					{conflict.versions > 0 && (
						<p>
							<Trans>This entry was changed on two devices before they synced.</Trans>
						</p>
					)}
					{conflict.deleted && (
						<p>
							<Trans>
								This entry was deleted on one device and changed on another before they synced.
							</Trans>
						</p>
					)}
					<div className="flex flex-wrap gap-2 pt-1">
						{conflict.versions > 0 ? (
							!open && (
								<Button variant="secondary" size="sm" disabled={busy} onClick={() => setOpen(true)}>
									<Trans>Compare versions</Trans>
								</Button>
							)
						) : (
							<>
								<Button
									variant="secondary"
									size="sm"
									disabled={busy}
									onClick={() => void run(() => onResolve({ kind: "keep", seen }))}
								>
									<Trans>Keep it</Trans>
								</Button>
								{deleteButton}
							</>
						)}
					</div>
					{error && (
						<p className="text-xs text-destructive" role="alert">
							{error}
						</p>
					)}
				</div>
			</div>

			{open && versions && (
				<div className="mt-3 space-y-3">
					<VersionCard
						title={t`The version shown`}
						saved={entry.updatedAt}
						entry={entry}
						notes={
							shownOnly === 0
								? []
								: [
										shownOnly === 1
											? t`It holds a passkey the other version doesn't.`
											: t`It holds ${shownOnly} passkeys the other version doesn't.`,
									]
						}
						actions={
							<Button
								variant="secondary"
								size="sm"
								disabled={busy}
								onClick={() => void run(() => onResolve({ kind: "keep", seen }))}
							>
								<Trans>Keep this one</Trans>
							</Button>
						}
					/>
					{versions.map((v) => (
						<VersionCard
							key={`${v.hlc.wall}:${v.hlc.counter}:${v.hlc.node}`}
							title={t`The other version`}
							saved={v.hlc.wall}
							entry={{ ...v.data, id: entry.id } as Entry}
							notes={differences(v.data)}
							actions={
								<>
									<Button
										variant="secondary"
										size="sm"
										disabled={busy}
										onClick={() => void run(() => onResolve({ kind: "use", hlc: v.hlc, seen }))}
									>
										<Trans>Use this one</Trans>
									</Button>
									<Button
										variant="secondary"
										size="sm"
										disabled={busy}
										onClick={() =>
											void run(() => onResolve({ kind: "keepBoth", hlc: v.hlc, seen }))
										}
									>
										<Trans>Keep both</Trans>
									</Button>
								</>
							}
						/>
					))}
					{conflict.deleted && <div className="flex justify-end">{deleteButton}</div>}
				</div>
			)}
		</div>
	);
}

/**
 * One version in full: its name, its mode's own detail body, custom fields and tags. Copying here
 * is not a use of the entry.
 */
function VersionCard({
	title,
	saved,
	entry,
	notes,
	actions,
}: {
	title: string;
	saved: number | undefined;
	entry: Entry;
	notes: string[];
	actions: ReactNode;
}) {
	const { t } = useLingui();
	const { clipboard } = usePlatform();
	const [copied, setCopied] = useState<string | null>(null);
	const Detail = getEntryMode(entry.type).Detail;
	const copy = async (label: string, value: string) => {
		try {
			await clipboard.copy(value);
			setCopied(label);
		} catch {
			// Clipboard write can fail when the document isn't focused. Best-effort.
		}
	};

	return (
		<div className="rounded-lg border border-border/50 bg-card/50 p-3 space-y-2">
			<div className="flex items-baseline justify-between gap-2">
				<p className="font-medium text-foreground">{title}</p>
				{saved !== undefined && (
					<p className="text-[10px] text-muted-foreground">{t`Saved ${formatDateTime(saved)}`}</p>
				)}
			</div>
			<p className="text-base truncate">{entry.name}</p>
			{notes.map((note) => (
				<p key={note} className="text-xs text-warning">
					{note}
				</p>
			))}
			<Detail entry={entry} copied={copied} copy={copy} />
			{entry.customFields && entry.customFields.length > 0 && (
				<CustomFieldsDetail fields={entry.customFields} copied={copied} copy={copy} />
			)}
			{entry.tags && entry.tags.length > 0 && (
				<div className="flex flex-wrap gap-1.5">
					{entry.tags.map((tag) => (
						<span
							key={tag}
							className="rounded-full border border-border/50 bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground"
						>
							{tag}
						</span>
					))}
				</div>
			)}
			<div className="flex flex-wrap justify-end gap-2">{actions}</div>
		</div>
	);
}
