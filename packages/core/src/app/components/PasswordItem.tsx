import { Copy, Eye, EyeOff, MoreVertical } from "lucide-react";
import { useState } from "react";

interface PasswordItemProps {
	name: string;
	username: string;
	url?: string;
}

export function PasswordItem({ name, username, url }: PasswordItemProps) {
	const [showPassword, setShowPassword] = useState(false);

	const handleCopy = () => {
		// Mock copy functionality
	};

	const getInitials = (text: string) => {
		return text.substring(0, 2).toUpperCase();
	};

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
				<button
					type="button"
					onClick={() => setShowPassword(!showPassword)}
					className="p-1.5 rounded-md border border-transparent hover:bg-primary/10 hover:border-border active:scale-[0.95] transition-all"
					aria-label={showPassword ? "Hide password" : "Show password"}
				>
					{showPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
				</button>
				<button
					type="button"
					onClick={handleCopy}
					className="p-1.5 rounded-md border border-transparent hover:bg-primary/10 hover:border-border active:scale-[0.95] transition-all"
					aria-label="Copy password"
				>
					<Copy className="w-3.5 h-3.5" />
				</button>
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
