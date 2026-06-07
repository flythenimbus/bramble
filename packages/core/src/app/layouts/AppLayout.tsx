import { Outlet, useMatches, useNavigate, useParams, useRouter } from "@tanstack/react-router";
import { ArrowLeft, ExternalLink, Lock, Moon, Settings as SettingsIcon, Sun } from "lucide-react";
import { usePlatform } from "../../context/PlatformContext";
import { useVault } from "../../hooks/useVault";
import { BrambleGlyph } from "../components/BrambleGlyph";
import { usePopOut } from "../hooks/usePopOut";
import { useTheme } from "../hooks/useTheme";

export function AppLayout() {
	const router = useRouter();
	const navigate = useNavigate();
	const { darkMode, toggleTheme } = useTheme();
	const { lock, pendingSyncCount } = useVault();
	const { popOut, canPopOut } = usePopOut();
	const { shell } = usePlatform();

	const matches = useMatches();
	const params = useParams({ strict: false }) as Record<string, string>;
	const backData = matches.at(-1)?.staticData.back;
	const onBack = backData
		? () => {
				if (router.history.canGoBack()) {
					router.history.back();
					return;
				}
				navigate({
					to: backData.to,
					params: Object.fromEntries((backData.paramKeys ?? []).map((k) => [k, params[k]])),
				});
			}
		: null;

	return (
		<div className="h-screen flex flex-col bg-gradient-to-br from-background via-background to-primary/5">
			<header className="shrink-0 backdrop-blur-xl bg-background/80 border-b border-border/50 z-40">
				<div className="max-w-5xl mx-auto px-4 py-3">
					<div className="flex items-center justify-between">
						<div className="flex items-center gap-3">
							{onBack && (
								<button
									type="button"
									onClick={onBack}
									className="flex items-center justify-center w-9 h-9 rounded-full bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground active:scale-[0.95] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
									aria-label="Go back"
									title="Go back"
								>
									<ArrowLeft className="w-4 h-4" />
								</button>
							)}
							<button
								type="button"
								onClick={() => navigate({ to: "/vault" })}
								className="flex items-center gap-2.5 rounded-lg active:scale-[0.98] transition-all"
								aria-label="Go to vault"
							>
								<BrambleGlyph className="w-9 h-9 text-foreground shrink-0" />
								<h1 className="text-lg bg-gradient-to-r from-foreground to-foreground/70 bg-clip-text text-transparent">
									{shell.appName}
								</h1>
							</button>
						</div>
						<div className="flex items-center gap-1.5">
							{pendingSyncCount > 0 && (
								<span
									className="text-[11px] px-2 py-1 rounded-md bg-primary/10 text-primary border border-primary/20"
									title="Vault changes saved by autofill while the popup was closed are syncing to disk"
								>
									{pendingSyncCount} pending sync
								</span>
							)}
							{canPopOut && (
								<button
									type="button"
									onClick={popOut}
									className="p-2 rounded-lg border border-transparent hover:bg-primary/10 hover:border-border active:scale-[0.95] transition-all"
									aria-label="Open in window"
									title="Open in window"
								>
									<ExternalLink className="w-4 h-4" />
								</button>
							)}
							<button
								type="button"
								onClick={() => {
									void lock();
								}}
								className="p-2 rounded-lg border border-transparent hover:bg-primary/10 hover:border-border active:scale-[0.95] transition-all"
								aria-label="Lock vault"
								title="Lock vault"
							>
								<Lock className="w-4 h-4" />
							</button>
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
