import { Outlet, useNavigate, useParams, useRouterState } from "@tanstack/react-router";
import {
	ArrowLeft,
	ExternalLink,
	Lock,
	Moon,
	Settings as SettingsIcon,
	Shield,
	Sun,
} from "lucide-react";
import { useEffect } from "react";
import { useVault } from "../../hooks/useVault";
import { usePopOut } from "../hooks/usePopOut";
import { useTheme } from "../hooks/useTheme";

export function AppLayout() {
	const navigate = useNavigate();
	const { darkMode, toggleTheme } = useTheme();
	const { lock, isLocked, ready } = useVault();
	const { popOut, canPopOut } = usePopOut();

	// Locking from anywhere inside the app (this header's button, Settings'
	// "Lock now", a future auto-lock) only flips isLocked — bounce back to the
	// unlock screen when it does, for every authed route. Gated on `ready` so a
	// popped-out window restoring a deep route isn't redirected during the brief
	// pre-hydration window where isLocked still holds its default `true`.
	useEffect(() => {
		if (ready && isLocked) navigate({ to: "/" });
	}, [ready, isLocked, navigate]);

	// The per-screen "Back to …" link now lives in the header (left of the
	// logo). Derive its target + accessible label from the current route so
	// each screen doesn't have to render its own. Vault home has no back.
	const pathname = useRouterState({ select: (s) => s.location.pathname });
	const { entryId } = useParams({ strict: false }) as { entryId?: string };
	let back: { label: string; onClick: () => void } | null = null;
	if (pathname === "/settings") {
		back = { label: "Back to vault", onClick: () => navigate({ to: "/vault" }) };
	} else if (pathname.startsWith("/vault/new")) {
		back = { label: "Back to vault", onClick: () => navigate({ to: "/vault" }) };
	} else if (entryId) {
		back = pathname.endsWith("/edit")
			? {
					label: "Back to details",
					onClick: () => navigate({ to: "/vault/$entryId", params: { entryId } }),
				}
			: { label: "Back to vault", onClick: () => navigate({ to: "/vault" }) };
	}

	return (
		<div className="h-screen flex flex-col bg-gradient-to-br from-background via-background to-primary/5">
			<header className="shrink-0 backdrop-blur-xl bg-background/80 border-b border-border/50 z-40">
				<div className="max-w-5xl mx-auto px-4 py-3">
					<div className="flex items-center justify-between">
						<div className="flex items-center gap-3">
							{back && (
								<button
									type="button"
									onClick={back.onClick}
									className="flex items-center justify-center w-9 h-9 rounded-full bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground active:scale-[0.95] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
									aria-label={back.label}
									title={back.label}
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
								<div className="flex items-center justify-center w-8 h-8 rounded-lg bg-gradient-to-br from-primary to-primary/80 shadow-lg shadow-primary/25">
									<Shield className="w-4.5 h-4.5 text-primary-foreground" />
								</div>
								<h1 className="text-lg bg-gradient-to-r from-foreground to-foreground/70 bg-clip-text text-transparent">
									PassGuard
								</h1>
							</button>
						</div>
						<div className="flex items-center gap-1.5">
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
