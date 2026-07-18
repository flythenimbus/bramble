import { useLingui } from "@lingui/react/macro";
import { Outlet, useMatches, useNavigate, useParams, useRouter } from "@tanstack/react-router";
import { ExternalLink, Lock, Settings as SettingsIcon } from "lucide-react";
import { usePlatform } from "../../context/PlatformContext";
import { useVault } from "../../hooks/useVault";
import { useVaultRegistry } from "../../hooks/useVaultRegistry";
import { displayLabel } from "../../vault/vault-registry";
import { BrambleGlyph } from "../components/BrambleGlyph";
import { PasskeySavedToast } from "../components/PasskeySavedToast";
import { BackButton } from "../components/ui/back-button";
import { Button } from "../components/ui/button";
import { usePopOut } from "../hooks/usePopOut";

/** App chrome (header with back/lock/theme/settings) wrapping the routed Outlet. */
export function AppLayout() {
	const router = useRouter();
	const navigate = useNavigate();
	const { lock } = useVault();
	const { popOut, canPopOut } = usePopOut();
	const { shell } = usePlatform();
	const { t } = useLingui();

	// Show which vault is open next to the brand. Falls back to "Vault N" for an unnamed vault,
	// matching the picker.
	const { activeId, vaults } = useVaultRegistry();
	const activeIndex = vaults.findIndex((v) => v.id === activeId);
	const vaultLabel =
		activeIndex >= 0 ? displayLabel(vaults[activeIndex]!.label, activeIndex) : null;

	// Back prefers real history (so Edit-from-list returns to the list) and falls
	// back to the route's staticData.back when there's none (a popped-out window
	// booted straight onto a deep route). paramKeys resolves the fallback's path
	// params from current params, since staticData can't hold runtime values.
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
							{onBack && <BackButton onClick={onBack} />}
							<Button
								variant="link"
								size="none"
								onClick={() => navigate({ to: "/vault" })}
								className="flex items-center gap-2.5 rounded-lg active:scale-[0.98]"
								aria-label={t`Go to vault`}
							>
								<BrambleGlyph className="w-9 h-9 text-foreground shrink-0" />
								<div className="flex items-center gap-2 min-w-0">
									<h1 className="text-lg bg-gradient-to-r from-foreground to-foreground/70 bg-clip-text text-transparent">
										{shell.appName}
									</h1>
									{vaultLabel && (
										<>
											<span aria-hidden="true" className="text-muted-foreground/40">
												·
											</span>
											<span
												data-testid="active-vault-label"
												className="max-w-[11rem] truncate text-sm text-foreground/70"
											>
												{vaultLabel}
											</span>
										</>
									)}
								</div>
							</Button>
						</div>
						<div className="flex items-center gap-1.5">
							{canPopOut && (
								<Button
									variant="ghost"
									size="icon"
									onClick={popOut}
									aria-label={t`Open in window`}
									title={t`Open in window`}
								>
									<ExternalLink className="w-4 h-4" />
								</Button>
							)}
							<Button
								variant="ghost"
								size="icon"
								onClick={() => {
									void lock();
								}}
								aria-label={t`Lock vault`}
								title={t`Lock vault`}
							>
								<Lock className="w-4 h-4" />
							</Button>
							<Button
								variant="ghost"
								size="icon"
								onClick={() => navigate({ to: "/settings" })}
								aria-label={t`Settings`}
							>
								<SettingsIcon className="w-4 h-4" />
							</Button>
						</div>
					</div>
				</div>
			</header>
			<Outlet />
			<PasskeySavedToast />
		</div>
	);
}
