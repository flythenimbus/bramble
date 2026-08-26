import { Trans, useLingui } from "@lingui/react/macro";
import { ChevronDown, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { EntryType } from "../../hooks/useVault";
import { modeList } from "../entry-modes";
import { Button } from "./ui/button";

interface AddDropdownProps {
	onCreate: (type: EntryType) => void;
}

export function AddDropdown({ onCreate }: AddDropdownProps) {
	const { t } = useLingui();
	const [isOpen, setIsOpen] = useState(false);
	const dropdownRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		function handleClickOutside(event: MouseEvent) {
			if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
				setIsOpen(false);
			}
		}

		document.addEventListener("mousedown", handleClickOutside);
		return () => document.removeEventListener("mousedown", handleClickOutside);
	}, []);

	const handleItemClick = (type: EntryType) => {
		setIsOpen(false);
		onCreate(type);
	};

	return (
		<div className="relative" ref={dropdownRef}>
			<Button
				variant="primary"
				size="none"
				onClick={() => setIsOpen(!isOpen)}
				aria-label={t`Add New`}
				aria-expanded={isOpen}
				className="flex items-center gap-2 px-4 py-2 h-full"
			>
				<Plus className="w-4 h-4" />
				{/* Dropped only on a genuinely narrow screen: spelled out, this button takes
					half the row and the search field next to it wraps its own label. The
					threshold is 480px rather than the `sm` default of 640px, because the label
					plus its icons is about 130px and anything above ~480px still leaves the
					search field more than enough room. */}
				<span className="hidden min-[480px]:inline text-sm">
					<Trans>Add New</Trans>
				</span>
				<ChevronDown className={`w-4 h-4 transition-transform ${isOpen ? "rotate-180" : ""}`} />
			</Button>

			{isOpen && (
				<div className="absolute right-0 mt-2 w-64 rounded-lg border border-border/50 bg-card shadow-xl shadow-black/10 overflow-hidden z-50">
					{modeList.map((mode) => {
						const Icon = mode.icon;
						return (
							<button
								type="button"
								key={mode.type}
								onClick={() => handleItemClick(mode.type)}
								className="w-full flex items-start gap-3 px-4 py-3 hover:bg-primary/5 transition-colors text-left border-b border-border/30 last:border-b-0"
							>
								<div className="flex items-center justify-center w-8 h-8 rounded-lg bg-primary/10 mt-0.5">
									<Icon className="w-4 h-4 text-primary" />
								</div>
								<div className="flex-1 min-w-0">
									<p className="text-sm">{mode.label}</p>
									<p className="text-xs text-muted-foreground">{mode.description}</p>
								</div>
							</button>
						);
					})}
				</div>
			)}
		</div>
	);
}
