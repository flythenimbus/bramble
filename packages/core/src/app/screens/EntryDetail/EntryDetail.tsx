import { ArrowLeft, Check, Copy, Eye, EyeOff, Globe, Pencil, Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import type { Entry } from "../../../hooks/useVault";

interface EntryDetailProps {
	entry: Entry;
	onBack: () => void;
	onEdit: () => void;
	onDelete: () => Promise<void>;
}

export function EntryDetail({ entry, onBack, onEdit, onDelete }: EntryDetailProps) {
	const [showPassword, setShowPassword] = useState(false);
	const [copied, setCopied] = useState<string | null>(null);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [deleting, setDeleting] = useState(false);

	useEffect(() => {
		if (!copied) return;
		const id = setTimeout(() => setCopied(null), 1500);
		return () => clearTimeout(id);
	}, [copied]);

	const copy = async (label: string, value: string) => {
		try {
			await navigator.clipboard.writeText(value);
			setCopied(label);
		} catch {
			// Clipboard write can fail when the document isn't focused. Best-effort.
		}
	};

	const handleDelete = async () => {
		setDeleting(true);
		try {
			await onDelete();
		} finally {
			setDeleting(false);
		}
	};

	return (
		<main className="max-w-5xl mx-auto px-4 py-5">
			<button
				onClick={onBack}
				type="button"
				className="flex items-center gap-2 mb-4 text-sm text-muted-foreground hover:text-foreground active:scale-[0.98] transition-all"
			>
				<ArrowLeft className="w-4 h-4" />
				Back to passwords
			</button>

			<div className="rounded-lg border border-border/50 bg-card/50 backdrop-blur-sm overflow-hidden">
				<div className="p-6 space-y-5">
					<div className="flex items-center gap-3">
						<div className="flex items-center justify-center w-12 h-12 rounded-lg bg-gradient-to-br from-primary/20 to-primary/10 shadow-sm">
							<span className="text-sm text-primary">
								{entry.name.substring(0, 2).toUpperCase()}
							</span>
						</div>
						<div className="min-w-0">
							<h2 className="text-lg truncate">{entry.name}</h2>
							{entry.url && <p className="text-xs text-muted-foreground truncate">{entry.url}</p>}
						</div>
					</div>

					{entry.url && (
						<Field label="Website" copyKey={copied} onCopy={() => copy("website", entry.url)}>
							<div className="flex items-center gap-2 text-sm">
								<Globe className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
								<span className="truncate">{entry.url}</span>
							</div>
						</Field>
					)}

					<Field
						label="Username"
						copyKey={copied}
						copyName="username"
						onCopy={() => copy("username", entry.username)}
					>
						<span className="text-sm truncate">{entry.username || "—"}</span>
					</Field>

					<Field
						label="Password"
						copyKey={copied}
						copyName="password"
						onCopy={() => copy("password", entry.password)}
						extraAction={
							<button
								type="button"
								onClick={() => setShowPassword((v) => !v)}
								className="p-1.5 rounded-md border border-transparent hover:bg-primary/10 hover:border-border active:scale-[0.95] transition-all"
								aria-label={showPassword ? "Hide password" : "Show password"}
							>
								{showPassword ? (
									<EyeOff className="w-3.5 h-3.5" />
								) : (
									<Eye className="w-3.5 h-3.5" />
								)}
							</button>
						}
					>
						<span className="text-sm font-mono truncate">
							{showPassword ? entry.password : "•".repeat(Math.min(entry.password.length, 16))}
						</span>
					</Field>

					{entry.notes && (
						<div className="space-y-1.5">
							<p className="text-xs text-muted-foreground">Notes</p>
							<p className="text-sm whitespace-pre-wrap">{entry.notes}</p>
						</div>
					)}
				</div>

				<div className="px-6 py-4 bg-muted/30 border-t border-border/50 flex items-center justify-between gap-3">
					{confirmDelete ? (
						<>
							<p className="flex-1 text-xs text-destructive">Delete this entry permanently?</p>
							<button
								type="button"
								onClick={() => setConfirmDelete(false)}
								disabled={deleting}
								className="px-4 py-2 text-sm rounded-lg border border-border hover:bg-background/50 active:scale-[0.98] transition-all disabled:opacity-50"
							>
								Cancel
							</button>
							<button
								type="button"
								onClick={handleDelete}
								disabled={deleting}
								className="px-5 py-2 text-sm rounded-lg bg-destructive text-destructive-foreground border border-destructive/20 hover:bg-destructive/90 active:scale-[0.98] transition-all disabled:opacity-50"
							>
								{deleting ? "Deleting…" : "Delete"}
							</button>
						</>
					) : (
						<>
							<button
								type="button"
								onClick={() => setConfirmDelete(true)}
								className="flex items-center gap-2 px-4 py-2 text-sm rounded-lg border border-border hover:bg-destructive/10 hover:text-destructive hover:border-destructive/30 active:scale-[0.98] transition-all"
							>
								<Trash2 className="w-3.5 h-3.5" />
								Delete
							</button>
							<div className="flex-1" />
							<button
								type="button"
								onClick={onEdit}
								className="flex items-center gap-2 px-5 py-2 text-sm rounded-lg bg-primary text-primary-foreground border border-primary/20 hover:bg-primary/90 active:scale-[0.98] transition-all"
							>
								<Pencil className="w-3.5 h-3.5" />
								Edit
							</button>
						</>
					)}
				</div>
			</div>
		</main>
	);
}

interface FieldProps {
	label: string;
	children: ReactNode;
	copyKey: string | null;
	copyName?: string;
	onCopy: () => void;
	extraAction?: ReactNode;
}

function Field({ label, children, copyKey, copyName, onCopy, extraAction }: FieldProps) {
	const matched = copyName ? copyKey === copyName : false;
	return (
		<div className="space-y-1.5">
			<p className="text-xs text-muted-foreground">{label}</p>
			<div className="flex items-center gap-2 px-3 py-2.5 rounded-md border border-border/50">
				<div className="flex-1 min-w-0">{children}</div>
				{extraAction}
				<button
					type="button"
					onClick={onCopy}
					className="p-1.5 rounded-md border border-transparent hover:bg-primary/10 hover:border-border active:scale-[0.95] transition-all"
					aria-label={`Copy ${label.toLowerCase()}`}
				>
					{matched ? (
						<Check className="w-3.5 h-3.5 text-primary" />
					) : (
						<Copy className="w-3.5 h-3.5" />
					)}
				</button>
			</div>
		</div>
	);
}
