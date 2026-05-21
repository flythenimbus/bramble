import { Check, Copy, MoreVertical } from "lucide-react";
import { useEffect, useRef, useState } from "react";

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
}

export function PasswordItem({
	name,
	username,
	password,
	url,
	customFields = [],
}: PasswordItemProps) {
	const [menuOpen, setMenuOpen] = useState(false);
	const [copied, setCopied] = useState<string | null>(null);
	const menuRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!menuOpen) return;
		const handler = (e: MouseEvent) => {
			if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
				setMenuOpen(false);
			}
		};
		document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, [menuOpen]);

	useEffect(() => {
		if (!copied) return;
		const id = setTimeout(() => setCopied(null), 1500);
		return () => clearTimeout(id);
	}, [copied]);

	const copyToClipboard = async (label: string, value: string) => {
		try {
			await navigator.clipboard.writeText(value);
			setCopied(label);
			setMenuOpen(false);
		} catch {
		}
	};

	const getInitials = (text: string) => text.substring(0, 2).toUpperCase();

	return (
		<div className="group flex items-center gap-3 px-3 py-2.5 rounded-lg border border-border/50 hover:border-primary/30 hover:bg-gradient-to-r hover:from-primary/5 hover:to-transparent transition-all duration-200 cursor-pointer">
			<div className="flex items-center justify-center w-9 h-9 rounded-lg bg-gradient-to-br from-primary/20 to-primary/10 shadow-sm">
				<span className="text-xs text-primary">{getInitials(name)}</span>
			</div>

			<div className="flex-1 min-w-0">
				<div className="flex items-baseline gap-2">
					<h4 className="text-sm truncate">{name}</h4>
					{url && <span className="text-xs text-muted-foreground/60 truncate">{url}</span>}
				</div>
				<p className="text-xs text-muted-foreground truncate mt-0.5">{username}</p>
			</div>

			<div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
				<div className="relative" ref={menuRef}>
					<button
						type="button"
						onClick={(e) => {
							e.stopPropagation();
							setMenuOpen((o) => !o);
						}}
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
					{menuOpen && (
						<div className="absolute right-0 mt-2 min-w-44 rounded-lg border border-border/50 bg-card shadow-xl shadow-black/10 overflow-hidden z-50">
							<MenuItem onClick={() => copyToClipboard("username", username)}>
								Copy username
							</MenuItem>
							<MenuItem onClick={() => copyToClipboard("password", password)}>
								Copy password
							</MenuItem>
							{customFields.map((field) => (
								<MenuItem key={field.key} onClick={() => copyToClipboard(field.key, field.value)}>
									Copy {field.key}
								</MenuItem>
							))}
						</div>
					)}
				</div>
				<button
					type="button"
					className="p-1.5 rounded-md border border-transparent hover:bg-primary/10 hover:border-border active:scale-[0.95] transition-all"
					aria-label="More options"
				>
					<MoreVertical className="w-3.5 h-3.5" />
				</button>
			</div>
		</div>
	);
}

function MenuItem({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
	return (
		<button
			type="button"
			onClick={(e) => {
				e.stopPropagation();
				onClick();
			}}
			className="w-full flex items-center gap-2 px-3 py-2 text-xs text-left hover:bg-primary/5 transition-colors border-b border-border/30 last:border-b-0"
		>
			<Copy className="w-3 h-3 text-muted-foreground" />
			{children}
		</button>
	);
}
