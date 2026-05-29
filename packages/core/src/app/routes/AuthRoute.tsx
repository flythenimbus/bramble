import { usePlatform } from "../../context/PlatformContext";
import { useVault } from "../../hooks/useVault";
import { usePopOut } from "../hooks/usePopOut";
import { Auth } from "../screens/Auth/Auth";

export function AuthRoute() {
	const { shell } = usePlatform();
	const { popOut, canPopOut } = usePopOut();
	const { hasVault, unlock, hasWebauthnSlot, unlockWithSecurityKey } = useVault();

	// The "already unlocked → skip to /vault" redirect lives in this route's
	// beforeLoad (app/router.tsx); the router redirects before this component
	// renders, so there's no eager-navigate render race to work around here.

	return (
		<Auth
			hasVault={hasVault}
			appName={shell.appName}
			onUnlock={unlock}
			onOpenSetup={() => shell.openSetup()}
			onPopOut={canPopOut ? popOut : undefined}
			hasWebauthnSlot={hasWebauthnSlot}
			onUnlockWithSecurityKey={unlockWithSecurityKey}
		/>
	);
}
