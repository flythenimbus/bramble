import { Trans, useLingui } from "@lingui/react/macro";
import {
	AlertTriangle,
	Check,
	Copy,
	type LucideIcon,
	MoreVertical,
	Pencil,
	Trash2,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { usePlatform } from "../../context/PlatformContext";
import type { CopyItem } from "../entry-modes/types";
import { Button } from "./ui/button";

interface EntryRowProps {
	name: string;
	/** Secondary line under the name (username, masked card number, note preview). */
	secondary: string;
	/** Avatar icon, shown unless `initials` is provided. */
	icon: LucideIcon;
	initials?: string;
	/** Login-only "Breached" badge. */
	leaked?: boolean;
	/** Quick-copy actions; empty hides the copy button. */
	copyItems: CopyItem[];
	onSelect: () => void;
	onEdit: () => void;
	onDelete: () => Promise<void>;
	/** Called after a successful quick-copy, to record the entry as recently used. */
	onUse?: () => void;
	/** Tint the row when it matches the current site (surfaced at the top of the list). */
	highlighted?: boolean;
}

/** Type-agnostic vault-list row; type-specific projection is computed by the entry mode and passed in. */
export function EntryRow({
	name,
	secondary,
	icon: Icon,
	initials,
	leaked,
	copyItems,
	onSelect,
	onEdit,
	onDelete,
	onUse,
	highlighted,
}: EntryRowProps) {
	const { clipboard } = usePlatform();
	const { t } = useLingui();
	const [copyOpen, setCopyOpen] = useState(false);
	const [moreOpen, setMoreOpen] = useState(false);
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const [copied, setCopied] = useState<string | null>(null);
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

	return (
		<div
			// Marks the row while a dropdown is open. The list virtualizer positions each row with a
			// transform, which creates a stacking context the menu's own z-index can't escape, so the
			// NEXT rows paint over it (and swallow its clicks). The list lifts the marked row above
			// its siblings; see VaultHome's row wrapper.
			data-menu-open={copyOpen || moreOpen ? "" : undefined}
			className={`group flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-all duration-200 focus-within:ring-2 focus-within:ring-primary/30 ${
				highlighted
					? "border-primary/40 bg-primary/5"
					: "border-border/50 hover:border-primary/30 hover:bg-gradient-to-r hover:from-primary/5 hover:to-transparent"
			}`}
		>
			<button
				type="button"
				onClick={onSelect}
				className="flex-1 min-w-0 flex items-center gap-3 text-left rounded-md focus:outline-none cursor-pointer"
				aria-label={t`Open ${name}`}
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
					</div>
					<p className="text-xs text-muted-foreground truncate mt-0.5">{secondary}</p>
				</div>
			</button>

			{/* Right slot: at rest shows the "Breached" badge (if any), swapped
				for the action controls on hover/focus. Both share one grid cell
				so the row's right edge never shifts. */}
			<div className="relative shrink-0 grid">
				{leaked && (
					<span
						className="row-start-1 col-start-1 justify-self-end self-center inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] uppercase tracking-wide bg-destructive/10 text-destructive border border-destructive/20 opacity-100 group-hover:opacity-0 focus-within:opacity-0 transition-opacity pointer-events-none"
						title={t`Password found in a known data breach`}
					>
						<AlertTriangle className="w-3 h-3" />
						<Trans>Breached</Trans>
					</span>
				)}
				<div className="row-start-1 col-start-1 justify-self-end self-center flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
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
