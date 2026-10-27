import { createContext, type ReactNode, useContext } from "react";
import type { AutofillAdapter } from "../adapters/autofill";
import type { BackupActivityAdapter } from "../adapters/backup-activity";
import type { BackupCredentialsAdapter } from "../adapters/backup-creds";
import type { BiometricUnlock } from "../adapters/biometric";
import type { ClipboardAdapter } from "../adapters/clipboard";
import type { CryptoAdapter } from "../adapters/crypto";
import type { DesktopLinkAdapter } from "../adapters/desktop-link";
import type { CredentialExchangeAdapter } from "../adapters/exchange";
import type { FileAdapter } from "../adapters/files";
import type { HttpTransport } from "../adapters/http";
import type { PairingAdapter } from "../adapters/pairing";
import type { ShellAdapter } from "../adapters/shell";
import type { StorageAdapter } from "../adapters/storage";
import { type CapabilityKey, can, type Surface, surfaceOf, type Target } from "../flags";

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
	/** Pairing with a browser extension over a local channel. Desktop only; undefined
	 * elsewhere, where the Settings section then does not render. */
	pairing?: PairingAdapter;
	/** The other end of `pairing`: linking this browser to the desktop app. Extension only. */
	desktopLink?: DesktopLinkAdapter;
	/** Backup credentials in the OS credential store, and the transport that uses them. Desktop
	 * only; elsewhere credentials stay VEK-wrapped and backups are unlock-gated. */
	backupCreds?: BackupCredentialsAdapter;
	/**
	 * How this platform reaches a third-party host. Undefined means it can simply `fetch`, which
	 * is the extension and the dev browser; the desktop and mobile supply one because their
	 * webviews cannot reach an arbitrary provider at all. See adapters/http.
	 */
	http?: HttpTransport;
	/** Backups running outside the settings screen, so it can show them. Mobile only; see
	 * adapters/backup-activity. */
	backupActivity?: BackupActivityAdapter;
	/** File attachments: the sealed-blob store and the platform's sealer. Absent where the
	 * platform has nowhere to put the bytes, and the UI then hides attachments entirely. */
	files?: FileAdapter;
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

/**
 * The current target's UI surface. Read this only for input-model differences
 * (pointer vs touch: hover affordances, long-press); anything feature-shaped
 * belongs in CAPABILITIES behind `useCan`.
 */
export function useSurface(): Surface {
	return surfaceOf(usePlatform().target);
}
