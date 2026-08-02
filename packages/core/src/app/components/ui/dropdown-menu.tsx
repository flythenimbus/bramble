import { ChevronDown } from "lucide-react";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { Button, type ButtonProps } from "./button";
import { cn } from "./utils";

// The app's menu primitive. AddDropdown and EntryRow's row menus predate it and still
// roll their own; new menus should use this one.

const MenuContext = createContext<{ close: () => void } | null>(null);

interface DropdownMenuProps {
	/** Trigger label. Omit for an icon-only trigger, and set `ariaLabel` instead. */
	label?: ReactNode;
	icon?: ReactNode;
	/** Hidden when there is no label. */
	ariaLabel?: string;
	variant?: ButtonProps["variant"];
	size?: ButtonProps["size"];
	disabled?: boolean;
	/** Which edge the panel hangs from. */
	align?: "left" | "right";
	className?: string;
	panelClassName?: string;
	children: ReactNode;
}

/** Button that opens a menu panel; dismissed by Esc, an outside click, or picking an item. */
export function DropdownMenu({
	label,
	icon,
	ariaLabel,
	variant = "secondary",
	size = "sm",
	disabled,
	align = "right",
	className,
	panelClassName,
	children,
}: DropdownMenuProps) {
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		const onPointer = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setOpen(false);
		};
		document.addEventListener("mousedown", onPointer);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onPointer);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);

	return (
		<div className="relative" ref={ref}>
			<Button
				variant={variant}
				size={size}
				disabled={disabled}
				onClick={() => setOpen((o) => !o)}
				aria-label={ariaLabel}
				aria-expanded={open}
				aria-haspopup="menu"
				className={className}
			>
				{icon}
				{label}
				<ChevronDown className={cn("w-3.5 h-3.5 transition-transform", open && "rotate-180")} />
			</Button>

			{open && (
				<div
					role="menu"
					className={cn(
						"absolute mt-2 min-w-44 rounded-lg border border-border/50 bg-card shadow-xl shadow-black/10 overflow-hidden z-50",
						align === "right" ? "right-0" : "left-0",
						panelClassName,
					)}
				>
					<MenuContext.Provider value={{ close: () => setOpen(false) }}>
						{children}
					</MenuContext.Provider>
				</div>
			)}
		</div>
	);
}

interface DropdownMenuItemProps {
	icon?: ReactNode;
	destructive?: boolean;
	disabled?: boolean;
	onSelect: () => void;
	children: ReactNode;
}

/** One menu row. Closes the menu before running its action. */
export function DropdownMenuItem({
	icon,
	destructive,
	disabled,
	onSelect,
	children,
}: DropdownMenuItemProps) {
	const menu = useContext(MenuContext);
	return (
		<button
			type="button"
			role="menuitem"
			disabled={disabled}
			onClick={() => {
				menu?.close();
				onSelect();
			}}
			className={cn(
				"w-full flex items-center gap-2 px-3 py-2 text-xs text-left transition-colors border-b border-border/30 last:border-b-0 disabled:opacity-50 disabled:cursor-not-allowed",
				destructive ? "text-destructive hover:bg-destructive/5" : "hover:bg-primary/5",
			)}
		>
			{icon}
			{children}
		</button>
	);
}
