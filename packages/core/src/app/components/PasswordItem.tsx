import { Check, Copy, MoreVertical, Pencil, Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

interface CustomField {
	key: string;
	value: string;
}

interface PasswordItemProps {
	name: string;
	username: string;
	password: string;
	url?: string;
	customFields?: CustomField[];
	onSelect: () => void;
	onEdit: () => void;
	onDelete: () => Promise<void>;
}

export function PasswordItem({
	name,
	username,
	password,
	url,
	customFields = [],
	onSelect,
	onEdit,
	onDelete,
}: PasswordItemProps) {
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

	const copyToClipboard = async (label: string, value: string) => {
		try {
			await navigator.clipboard.writeText(value);
			setCopied(label);
			setCopyOpen(false);
		} catch {
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

	const getInitials = (text: string) => text.substring(0, 2).toUpperCase();

	return (
		<div className="group flex items-center gap-3 px-3 py-2.5 rounded-lg border border-border/50 hover:border-primary/30 hover:bg-gradient-to-r hover:from-primary/5 hover:to-transparent transition-all duration-200 focus-within:ring-2 focus-within:ring-primary/30">
			<button
				type="button"
				onClick={onSelect}
				className="flex-1 min-w-0 flex items-center gap-3 text-left rounded-md focus:outline-none cursor-pointer"
				aria-label={`Open ${name}`}
			>
				<div className="flex items-center justify-center w-9 h-9 rounded-lg bg-gradient-to-br from-primary/20 to-primary/10 shadow-sm shrink-0">
					<span className="text-xs text-primary">{getInitials(name)}</span>
				</div>

				<div className="flex-1 min-w-0">
					<div className="flex items-baseline gap-2">
						<h4 className="text-sm truncate">{name}</h4>
						{url && <span className="text-xs text-muted-foreground/60 truncate">{url}</span>}
					</div>
					<p className="text-xs text-muted-foreground truncate mt-0.5">{username}</p>
				</div>
			</button>

			<div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
				<div className="relative" ref={copyRef}>
					<button
						type="button"
						onClick={() => setCopyOpen((o) => !o)}
						className="p-1.5 rounded-md border border-transparent hover:bg-primary/10 hover:border-border active:scale-[0.95] transition-all"
						aria-label={copied ? `Copied ${copied}` : "Copy"}
						title={copied ? `Copied ${copied}` : "Copy"}
					>
						{copied ? (
							<Check className="w-3.5 h-3.5 text-primary" />
						) : (
							<Copy className="w-3.5 h-3.5" />
						)}
					</button>
					{copyOpen && (
						<div className="absolute right-0 mt-2 min-w-44 rounded-lg border border-border/50 bg-card shadow-xl shadow-black/10 overflow-hidden z-50">
							<MenuItem
								icon={<Copy className="w-3 h-3 text-muted-foreground" />}
								onClick={() => copyToClipboard("username", username)}
							>
								Copy username
							</MenuItem>
							<MenuItem
								icon={<Copy className="w-3 h-3 text-muted-foreground" />}
								onClick={() => copyToClipboard("password", password)}
							>
								Copy password
							</MenuItem>
							{customFields.map((field) => (
								<MenuItem
									key={field.key}
									icon={<Copy className="w-3 h-3 text-muted-foreground" />}
									onClick={() => copyToClipboard(field.key, field.value)}
								>
									Copy {field.key}
								</MenuItem>
							))}
						</div>
					)}
				</div>

				<div className="relative" ref={moreRef}>
					<button
						type="button"
						onClick={() => {
							setMoreOpen((o) => !o);
							setConfirmingDelete(false);
						}}
						className="p-1.5 rounded-md border border-transparent hover:bg-primary/10 hover:border-border active:scale-[0.95] transition-all"
						aria-label="More options"
						aria-expanded={moreOpen}
					>
						<MoreVertical className="w-3.5 h-3.5" />
					</button>
					{moreOpen && (
						<div className="absolute right-0 mt-2 min-w-44 rounded-lg border border-border/50 bg-card shadow-xl shadow-black/10 overflow-hidden z-50">
							{confirmingDelete ? (
								<div className="p-3 space-y-2">
									<p className="text-xs text-foreground">Delete this entry?</p>
									<div className="flex items-center gap-2">
										<button
											type="button"
											onClick={() => setConfirmingDelete(false)}
											disabled={deleting}
											className="flex-1 px-3 py-1.5 text-xs rounded-md border border-border hover:bg-background/50 active:scale-[0.98] transition-all disabled:opacity-50"
										>
											Cancel
										</button>
										<button
											type="button"
											onClick={handleDelete}
											disabled={deleting}
											className="flex-1 px-3 py-1.5 text-xs rounded-md bg-destructive text-destructive-foreground border border-destructive/20 hover:bg-destructive/90 active:scale-[0.98] transition-all disabled:opacity-50"
										>
											{deleting ? "Deleting…" : "Delete"}
										</button>
									</div>
								</div>
							) : (
								<>
									<MenuItem
										icon={<Pencil className="w-3 h-3 text-muted-foreground" />}
										onClick={handleEdit}
									>
										Edit
									</MenuItem>
									<MenuItem
										icon={<Trash2 className="w-3 h-3 text-destructive" />}
										destructive
										onClick={() => setConfirmingDelete(true)}
									>
										Delete
									</MenuItem>
								</>
							)}
						</div>
					)}
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
