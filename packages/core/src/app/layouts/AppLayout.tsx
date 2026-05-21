import { Outlet, useNavigate } from "@tanstack/react-router";
import { Moon, Settings as SettingsIcon, Shield, Sun } from "lucide-react";
import { useTheme } from "../hooks/useTheme";

export function AppLayout() {
	const navigate = useNavigate();
	const { darkMode, toggleTheme } = useTheme();
	return (
		<div className="h-screen flex flex-col bg-gradient-to-br from-background via-background to-primary/5">
			<header className="shrink-0 backdrop-blur-xl bg-background/80 border-b border-border/50 z-40">
				<div className="max-w-5xl mx-auto px-4 py-3">
					<div className="flex items-center justify-between">
						<button
							type="button"
							onClick={() => navigate({ to: "/vault" })}
							className="flex items-center gap-2.5 rounded-lg active:scale-[0.98] transition-all"
							aria-label="Go to vault"
						>
							<div className="flex items-center justify-center w-8 h-8 rounded-lg bg-gradient-to-br from-primary to-primary/80 shadow-lg shadow-primary/25">
								<Shield className="w-4.5 h-4.5 text-primary-foreground" />
							</div>
							<h1 className="text-lg bg-gradient-to-r from-foreground to-foreground/70 bg-clip-text text-transparent">
								PassGuard
							</h1>
						</button>
						<div className="flex items-center gap-1.5">
							<button
								type="button"
								onClick={toggleTheme}
								className="p-2 rounded-lg border border-transparent hover:bg-primary/10 hover:border-border active:scale-[0.95] transition-all"
								aria-label="Toggle theme"
							>
								{darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
							</button>
							<button
								type="button"
								onClick={() => navigate({ to: "/settings" })}
								className="p-2 rounded-lg border border-transparent hover:bg-primary/10 hover:border-border active:scale-[0.95] transition-all"
								aria-label="Settings"
							>
								<SettingsIcon className="w-4 h-4" />
							</button>
						</div>
					</div>
				</div>
			</header>
			<Outlet />
		</div>
	);
}
