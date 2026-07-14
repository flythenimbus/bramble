import { useLingui } from "@lingui/react/macro";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Archive, Info, Lock, type LucideIcon, SlidersHorizontal, Wifi } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useCan } from "../../../context/PlatformContext";
import { cn } from "../../components/ui/utils";
import { AboutSection } from "./components/AboutSection";
import { AppearanceSection } from "./components/AppearanceSection";
import { BackupSection } from "./components/BackupSection";
import { DataSection } from "./components/DataSection";
import { GeneralSection } from "./components/GeneralSection";
import { SecuritySection } from "./components/SecuritySection";
import { SupportSection } from "./components/SupportSection";
import { SyncConnectSection } from "./components/SyncConnectSection";
import type { SettingsTab } from "./settings-search";

export function Settings() {
	const { t } = useLingui();
	const canCloudBackup = useCan("cloudBackup");
	const { tab } = useSearch({ from: "/_app/settings" });
	const navigate = useNavigate();
	// replace: switching tabs shouldn't stack history entries.
	const setTab = (id: SettingsTab) =>
		navigate({ to: "/settings", search: (prev) => ({ ...prev, tab: id }), replace: true });

	// On narrow screens the horizontal tab strip can hide trailing tabs (e.g. "About") with no
	// affordance. Track scroll position and fade whichever edge still has tabs off-screen.
	const tabsRef = useRef<HTMLElement>(null);
	const [edges, setEdges] = useState({ left: false, right: false });
	useEffect(() => {
		const el = tabsRef.current;
		if (!el) return;
		const measure = () =>
			setEdges({
				left: el.scrollLeft > 1,
				right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1,
			});
		measure();
		el.addEventListener("scroll", measure, { passive: true });
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => {
			el.removeEventListener("scroll", measure);
			ro.disconnect();
		};
	}, []);

	const tabs: { id: SettingsTab; label: string; Icon: LucideIcon }[] = [
		{ id: "general", label: t`General`, Icon: SlidersHorizontal },
		{ id: "security", label: t`Security`, Icon: Lock },
		{ id: "backups", label: t`Backups`, Icon: Archive },
		{ id: "sync", label: t`Sync`, Icon: Wifi },
		{ id: "about", label: t`About`, Icon: Info },
	];

	return (
		<main className="max-w-5xl mx-auto px-4 py-5">
			<div className="relative mb-4">
				<nav
					ref={tabsRef}
					// overflow-y-hidden + touch-pan-x: horizontal scroll only, so a vertical drag on the
					// strip scrolls the page instead of dragging the tab row around (iOS).
					className="flex gap-1 overflow-x-auto overflow-y-hidden touch-pan-x border-b border-border/50 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
					aria-label={t`Settings sections`}
				>
					{tabs.map(({ id, label, Icon }) => (
						<button
							key={id}
							type="button"
							aria-current={tab === id}
							onClick={() => setTab(id)}
							className={cn(
								"flex shrink-0 items-center gap-1.5 px-3 py-2 text-sm whitespace-nowrap border-b-2 -mb-px transition-colors",
								tab === id
									? "border-primary text-foreground"
									: "border-transparent text-muted-foreground hover:text-foreground",
							)}
						>
							<Icon className="w-4 h-4" />
							{label}
						</button>
					))}
				</nav>
				{/* Scroll hints: fade the edge that still has tabs off-screen (only shows when overflowing). */}
				{edges.left && (
					<div className="pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-background to-transparent" />
				)}
				{edges.right && (
					<div className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-background to-transparent" />
				)}
			</div>

			<div className="space-y-4">
				{tab === "general" && (
					<>
						<GeneralSection />
						<AppearanceSection />
					</>
				)}
				{tab === "security" && <SecuritySection />}
				{tab === "backups" && (
					<>
						<DataSection />
						{/* Cloud backup providers gated off where not shipped (mobile); local export/import stays. */}
						{canCloudBackup && <BackupSection />}
					</>
				)}
				{tab === "sync" && <SyncConnectSection />}
				{tab === "about" && (
					<>
						<AboutSection />
						<SupportSection />
					</>
				)}
			</div>
		</main>
	);
}
