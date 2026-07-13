import { useLingui } from "@lingui/react/macro";
import { Database, Info, Lock, type LucideIcon, SlidersHorizontal, Wifi } from "lucide-react";
import { useState } from "react";
import { cn } from "../../components/ui/utils";
import { AboutSection } from "./components/AboutSection";
import { AppearanceSection } from "./components/AppearanceSection";
import { BackupSection } from "./components/BackupSection";
import { DataSection } from "./components/DataSection";
import { GeneralSection } from "./components/GeneralSection";
import { SecuritySection } from "./components/SecuritySection";
import { SyncConnectSection } from "./components/SyncConnectSection";

type TabId = "general" | "security" | "data" | "sync" | "about";

export function Settings() {
	const { t } = useLingui();
	const [tab, setTab] = useState<TabId>("general");

	const tabs: { id: TabId; label: string; Icon: LucideIcon }[] = [
		{ id: "general", label: t`General`, Icon: SlidersHorizontal },
		{ id: "security", label: t`Security`, Icon: Lock },
		{ id: "data", label: t`Data`, Icon: Database },
		{ id: "sync", label: t`Sync`, Icon: Wifi },
		{ id: "about", label: t`About`, Icon: Info },
	];

	return (
		<main className="max-w-5xl mx-auto px-4 py-5">
			<nav
				className="flex gap-1 overflow-x-auto border-b border-border/50 mb-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
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

			<div className="space-y-4">
				{tab === "general" && (
					<>
						<GeneralSection />
						<AppearanceSection />
					</>
				)}
				{tab === "security" && <SecuritySection />}
				{tab === "data" && (
					<>
						<DataSection />
						<BackupSection />
					</>
				)}
				{tab === "sync" && <SyncConnectSection />}
				{tab === "about" && <AboutSection />}
			</div>
		</main>
	);
}
