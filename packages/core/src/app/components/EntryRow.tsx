import { Trans, useLingui } from "@lingui/react/macro";
import {
	AlertTriangle,
	Check,
	Copy,
	KeyRound,
	type LucideIcon,
	MoreVertical,
	Pencil,
	Trash2,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { usePlatform, useSurface } from "../../context/PlatformContext";
import { useLongPress } from "../../hooks/useLongPress";
import type { CopyItem } from "../entry-modes/types";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";

interface EntryRowProps {
	name: string;
	/** Secondary line under the name (username, masked card number, note preview). */
	secondary: string;
	/** Avatar icon, shown unless `initials` is provided. */
	icon: LucideIcon;
	initials?: string;
	/** Login-only "Breached" badge. */
	leaked?: boolean;
	/** Login-only: passkeys held by this entry. Marked on the row because deleting the entry
	 * deletes them with it, so a duplicate carrying one is the copy worth keeping. */
	passkeys?: number;
	/** Quick-copy actions; empty hides the copy button. */
	copyItems: CopyItem[];
	onSelect: () => void;
	onEdit: () => void;
	onDelete: () => Promise<void>;
	/** Called after a successful quick-copy, to record the entry as recently used. */
	onUse?: () => void;
	/** Tint the row when it matches the current site (surfaced at the top of the list). */
	highlighted?: boolean;
	/**
	 * Bulk selection is active: show the checkbox, and make a tap toggle it instead of
	 * opening the entry. Entered by hovering a row on the extension, by long-press on mobile.
	 */
	selectMode?: boolean;
	selected?: boolean;
	onToggleSelect?: () => void;
	/** Touch long-press on the row. Omitted where selection isn't offered. */
	onLongPress?: () => void;
}

/** Type-agnostic vault-list row; type-specific projection is computed by the entry mode and passed in. */
export function EntryRow({
	name,
	secondary,
	icon: Icon,
	initials,
	leaked,
	passkeys = 0,
	copyItems,
	onSelect,
	onEdit,
	onDelete,
	onUse,
	highlighted,
	selectMode = false,
	selected = false,
	onToggleSelect,
	onLongPress,
}: EntryRowProps) {
	const { clipboard } = usePlatform();
	const { t } = useLingui();
	// Touch has no hover, so the row's controls can't hide behind it.
	const touch = useSurface() === "touch";
	const [copyOpen, setCopyOpen] = useState(false);
	const [moreOpen, setMoreOpen] = useState(false);
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const [copied, setCopied] = useState<string | null>(null);
	const passkeyLabel = passkeys === 1 ? t`Holds a passkey` : t`Holds ${passkeys} passkeys`;
	const copyRef = useRef<HTMLDivElement>(null);
	const moreRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!copyOpen && !moreOpen) return;
		const handler = (e: MouseEvent) => {
			const target = e.target as Node;
			if (copyOpen && copyRef.current && !copyRef.current.contains(target)) {
				setCopyOpen(false);
			}
			if (moreOpen && moreRef.current && !moreRef.current.contains(target)) {
				setMoreOpen(false);
				setConfirmingDelete(false);
			}
		};
		document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, [copyOpen, moreOpen]);

	useEffect(() => {
		if (!copied) return;
		const id = setTimeout(() => setCopied(null), 1500);
		return () => clearTimeout(id);
	}, [copied]);

	const copyToClipboard = async (label: string, value: CopyItem["value"]) => {
		try {
			// Resolved here, not at projection time, so a TOTP code is the one valid right now.
			await clipboard.copy(typeof value === "function" ? value() : value);
			setCopied(label);
			setCopyOpen(false);
			onUse?.();
		} catch {
			// Best-effort: clipboard write can fail if unfocused or permission revoked.
		}
	};

	const handleEdit = () => {
		setMoreOpen(false);
		onEdit();
	};

	const handleDelete = async () => {
		setDeleting(true);
		try {
			await onDelete();
		} finally {
			setDeleting(false);
			setConfirmingDelete(false);
			setMoreOpen(false);
		}
	};

	// In selection mode the row is a checkbox, not a link: tapping it toggles.
	const activate = selectMode && onToggleSelect ? onToggleSelect : onSelect;
	const press = useLongPress({
		onClick: activate,
		onLongPress: () => onLongPress?.(),
		enabled: touch && !!onLongPress,
	});

	return (
		<div
			// Marks the row while a dropdown is open. The list virtualizer positions each row with a
			// transform, which creates a stacking context the menu's own z-index can't escape, so the
			// NEXT rows paint over it (and swallow its clicks). The list lifts the marked row above
			// its siblings; see VaultHome's row wrapper.
			data-menu-open={copyOpen || moreOpen ? "" : undefined}
			// Targeted by the mobile stylesheet to kill the iOS long-press callout, which
			// inherits down to the pressable button inside.
			data-entry-row=""
			// select-none: a long press must enter selection mode, not start an OS text selection.
			className={`group flex items-center gap-3 px-3 py-2.5 rounded-lg border select-none transition-all duration-200 focus-within:ring-2 focus-within:ring-primary/30 ${
				selected
					? "border-primary/60 bg-primary/10"
					: highlighted
						? "border-primary/40 bg-primary/5"
						: "border-border/50 hover:border-primary/30 hover:bg-gradient-to-r hover:from-primary/5 hover:to-transparent"
			}`}
		>
			{/* Selection mode only: at rest the list stays clean, and the mode is entered
				deliberately (header button, or long-press on touch). */}
			{onToggleSelect && selectMode && (
				<Checkbox
					checked={selected}
					onChange={onToggleSelect}
					ariaLabel={t`Select ${name}`}
					// Negative margin + matching padding: a full-height hit target that
					// doesn't make the row taller.
					className="shrink-0 -my-2.5 py-2.5"
				/>
			)}

			{/* The press target: long-press here enters selection mode on touch. The
				row's own action buttons sit outside it, so pressing one is never
				ambiguous. */}
			<button
				type="button"
				{...press}
				className="flex-1 min-w-0 flex items-center gap-3 text-left rounded-md focus:outline-none cursor-pointer"
				// In selection mode this duplicates the checkbox beside it (tapping anywhere
				// on the row toggles, which pointers and thumbs both expect). Hidden from the
				// a11y tree so screen readers get one control per row, not two identical ones.
				aria-label={selectMode ? undefined : t`Open ${name}`}
				aria-hidden={selectMode || undefined}
				tabIndex={selectMode ? -1 : undefined}
			>
				<div className="flex items-center justify-center w-9 h-9 rounded-lg bg-gradient-to-br from-primary/20 to-primary/10 shadow-sm shrink-0">
					{initials ? (
						<span className="text-xs text-primary">{initials}</span>
					) : (
						<Icon className="w-4 h-4 text-primary" />
					)}
				</div>

				<div className="flex-1 min-w-0">
					<div className="flex items-baseline gap-2">
						<h4 className="text-sm truncate">{name}</h4>
						{passkeys > 0 && (
							<KeyRound
								className="w-3 h-3 text-primary shrink-0 self-center"
								aria-label={passkeyLabel}
								role="img"
							/>
						)}
					</div>
					<p className="text-xs text-muted-foreground truncate mt-0.5">{secondary}</p>
				</div>
			</button>

			{/* Right slot. On a pointer surface the "Breached" badge and the action
				controls share one grid cell, swapping on hover, so the row's right edge
				never shifts. Touch has no hover to swap on, so the two sit side by side
				and the actions are always reachable. */}
			<div className={touch ? "shrink-0 flex items-center gap-1.5" : "relative shrink-0 grid"}>
				{leaked && (
					<span
						className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] uppercase tracking-wide bg-destructive/10 text-destructive border border-destructive/20 pointer-events-none ${
							touch
								? ""
								: "row-start-1 col-start-1 justify-self-end self-center opacity-100 group-hover:opacity-0 focus-within:opacity-0 transition-opacity"
						}`}
						title={t`Password found in a known data breach`}
					>
						<AlertTriangle className="w-3 h-3" />
						<Trans>Breached</Trans>
					</span>
				)}
				{/* Dropped in selection mode: the row's job is then the checkbox, and a
					single-entry copy or delete would be an ambiguous tap. Unmounted rather
					than `hidden`, which a display utility on the same element would override. */}
				{!selectMode && (
					<div
						className={`flex items-center gap-1 ${
							touch
								? ""
								: "row-start-1 col-start-1 justify-self-end self-center opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity"
						}`}
					>
						{copyItems.length > 0 && (
							<div className="relative" ref={copyRef}>
								<Button
									variant="ghost"
									size="none"
									onClick={() => setCopyOpen((o) => !o)}
									className="p-1.5 rounded-md"
									aria-label={copied ? t`Copied ${copied}` : t`Copy`}
									title={copied ? t`Copied ${copied}` : t`Copy`}
								>
									{copied ? (
										<Check className="w-3.5 h-3.5 text-primary" />
									) : (
										<Copy className="w-3.5 h-3.5" />
									)}
								</Button>
								{copyOpen && (
									<div className="absolute right-0 mt-2 min-w-44 rounded-lg border border-border/50 bg-card shadow-xl shadow-black/10 overflow-hidden z-50">
										{copyItems.map((item) => (
											<MenuItem
												key={item.label}
												icon={<Copy className="w-3 h-3 text-muted-foreground" />}
												onClick={() => copyToClipboard(item.label, item.value)}
											>
												<Trans>Copy {item.label}</Trans>
											</MenuItem>
										))}
									</div>
								)}
							</div>
						)}

						<div className="relative" ref={moreRef}>
							<Button
								variant="ghost"
								size="none"
								onClick={() => {
									setMoreOpen((o) => !o);
									setConfirmingDelete(false);
								}}
								className="p-1.5 rounded-md"
								aria-label={t`More options`}
								aria-expanded={moreOpen}
							>
								<MoreVertical className="w-3.5 h-3.5" />
							</Button>
							{moreOpen && (
								<div className="absolute right-0 mt-2 min-w-44 rounded-lg border border-border/50 bg-card shadow-xl shadow-black/10 overflow-hidden z-50">
									{confirmingDelete ? (
										<div className="p-3 space-y-2">
											<p className="text-xs text-foreground">
												<Trans>Delete this entry?</Trans>
											</p>
											<div className="flex items-center gap-2">
												<Button
													variant="secondary"
													size="none"
													onClick={() => setConfirmingDelete(false)}
													disabled={deleting}
													className="flex-1 px-3 py-1.5 text-xs rounded-md hover:bg-background/50 hover:border-border"
												>
													<Trans>Cancel</Trans>
												</Button>
												<Button
													variant="destructive"
													size="none"
													onClick={handleDelete}
													disabled={deleting}
													className="flex-1 px-3 py-1.5 text-xs rounded-md"
												>
													{deleting ? <Trans>Deleting…</Trans> : <Trans>Delete</Trans>}
												</Button>
											</div>
										</div>
									) : (
										<>
											<MenuItem
												icon={<Pencil className="w-3 h-3 text-muted-foreground" />}
												onClick={handleEdit}
											>
												<Trans>Edit</Trans>
											</MenuItem>
											<MenuItem
												icon={<Trash2 className="w-3 h-3 text-destructive" />}
												destructive
												onClick={() => setConfirmingDelete(true)}
											>
												<Trans>Delete</Trans>
											</MenuItem>
										</>
									)}
								</div>
							)}
						</div>
					</div>
				)}
			</div>
		</div>
	);
}

function MenuItem({
	icon,
	onClick,
	destructive,
	children,
}: {
	icon: ReactNode;
	onClick: () => void;
	destructive?: boolean;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={`w-full flex items-center gap-2 px-3 py-2 text-xs text-left transition-colors border-b border-border/30 last:border-b-0 ${
				destructive ? "text-destructive hover:bg-destructive/5" : "hover:bg-primary/5"
			}`}
		>
			{icon}
			{children}
		</button>
	);
}
