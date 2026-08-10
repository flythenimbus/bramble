import { useLingui } from "@lingui/react/macro";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
	Archive,
	ChevronLeft,
	ChevronRight,
	Info,
	Lock,
	type LucideIcon,
	SlidersHorizontal,
	Wifi,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useCan } from "../../../context/PlatformContext";
import { cn } from "../../components/ui/utils";
import { AboutSection } from "./components/AboutSection";
import { AppearanceSection } from "./components/AppearanceSection";
import { BackupSection } from "./components/BackupSection";
import { BrowserPairingSection } from "./components/BrowserPairingSection";
import { DataSection } from "./components/DataSection";
import { DeleteVaultSection } from "./components/DeleteVaultSection";
import { DesktopLinkSection } from "./components/DesktopLinkSection";
import { GeneralSection } from "./components/GeneralSection";
import { RotateSecretSection } from "./components/RotateSecretSection";
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

	// Fade whichever edge of the tab strip still has tabs scrolled off (else they hide with no hint).
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
					// overflow-y-hidden + touch-pan-x: horizontal only, so a vertical drag scrolls the page (iOS).
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
				{edges.left && (
					<div className="pointer-events-none absolute inset-y-0 left-0 flex w-12 items-center bg-gradient-to-r from-background via-background to-transparent">
						<ChevronLeft className="h-4 w-4 text-foreground/80" />
					</div>
				)}
				{edges.right && (
					<div className="pointer-events-none absolute inset-y-0 right-0 flex w-12 items-center justify-end bg-gradient-to-l from-background via-background to-transparent">
						<ChevronRight className="h-4 w-4 text-foreground/80" />
					</div>
				)}
			</div>

			<div className="space-y-4">
				{tab === "general" && (
					<>
						<GeneralSection />
						<AppearanceSection />
						<DeleteVaultSection />
					</>
				)}
				{tab === "security" && (
					<>
						<SecuritySection />
						{/* Last, like Delete vault in General: destructive, occasionally necessary. */}
						<RotateSecretSection />
					</>
				)}
				{tab === "backups" && (
					<>
						<DataSection />
						{canCloudBackup && <BackupSection />}
					</>
				)}
				{tab === "sync" && (
					<div className="space-y-4">
						<SyncConnectSection />
						{/* Renders itself away where the platform has no pairing adapter. */}
						<BrowserPairingSection />
						{/* The mirror image, on the extension. Also renders itself away. */}
						<DesktopLinkSection />
					</div>
				)}
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
