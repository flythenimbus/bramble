import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { usePlatform } from "../../context/PlatformContext";
import { useVault } from "../../hooks/useVault";
import { usePopOut } from "../hooks/usePopOut";
import { Auth } from "../screens/Auth/Auth";

export function AuthRoute() {
	const navigate = useNavigate();
	const { shell } = usePlatform();
	const { popOut, canPopOut } = usePopOut();
	const { hasVault, isLocked, unlock } = useVault();

	// If we land on auth but the vault is already unlocked (e.g. popup reopen
	// while offscreen still holds the master key), skip straight to /vault.
	useEffect(() => {
		if (!isLocked) navigate({ to: "/vault" });
	}, [isLocked, navigate]);

	return (
		<Auth
			hasVault={hasVault}
			onUnlock={unlock}
			onOpenSetup={() => shell.openSetup()}
			onPopOut={canPopOut ? popOut : undefined}
		/>
	);
}
