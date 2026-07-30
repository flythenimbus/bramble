import { createContext, type ReactNode, useContext } from "react";
import type { AutofillAdapter } from "../adapters/autofill";
import type { BiometricUnlock } from "../adapters/biometric";
import type { ClipboardAdapter } from "../adapters/clipboard";
import type { CryptoAdapter } from "../adapters/crypto";
import type { CredentialExchangeAdapter } from "../adapters/exchange";
import type { ShellAdapter } from "../adapters/shell";
import type { StorageAdapter } from "../adapters/storage";
import { type CapabilityKey, can, type Target } from "../flags";

export interface Platform {
	/** Build-target identity; resolves platform capabilities (flags.ts `can`). */
	target: Target;
	storage: StorageAdapter;
	crypto: CryptoAdapter;
	autofill: AutofillAdapter;
	shell: ShellAdapter;
	clipboard: ClipboardAdapter;
	/** Device-local biometric unlock. Mobile only; undefined on the extension. */
	biometric?: BiometricUnlock;
	/** OS-driven credential exchange (FIDO CXP). iOS 26+ only; undefined elsewhere. */
	exchange?: CredentialExchangeAdapter;
}

const PlatformContext = createContext<Platform | null>(null);

export function PlatformProvider({
	platform,
	children,
}: {
	platform: Platform;
	children: ReactNode;
}) {
	return <PlatformContext.Provider value={platform}>{children}</PlatformContext.Provider>;
}

export function usePlatform(): Platform {
	const ctx = useContext(PlatformContext);
	if (!ctx) throw new Error("usePlatform called outside PlatformProvider");
	return ctx;
}

/** Resolve a platform capability for the current build target. */
export function useCan(cap: CapabilityKey): boolean {
	return can(cap, usePlatform().target);
}
