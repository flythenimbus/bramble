import type { BackupSecrets, BackupTargetConfig } from "../backup/config";
import type { BackupTransport } from "../backup/types";

/**
 * Backup credentials held by the OS credential store instead of being VEK-wrapped, plus the
 * transport that uses them.
 *
 * Desktop only. Undefined everywhere else, where credentials stay wrapped under the vault key
 * and a backup therefore runs only while that vault is unlocked. The desktop is the one target
 * that both HAS an OS credential store (Keychain / Credential Manager / Secret Service, already
 * holding this app's sync device identity) and is expected to sit there running, so it is the
 * one target where a per-vault backup schedule can actually be honoured. The trade is stated in
 * docs/cloud-storage-backups.md: those credentials become OS-account protected rather than
 * master-password protected, while the backups themselves stay sealed by the master password.
 *
 * The plaintext credential never crosses this interface. It goes in once at save time and is
 * used only inside the host process, which is also what makes `transport` necessary: the
 * desktop webview cannot reach a provider at all, since no S3 endpoint or WebDAV server grants
 * CORS to `tauri://localhost`.
 */
export interface BackupCredentialsAdapter {
	/**
	 * Whether the OS credential store can actually be used right now (a Linux session with no
	 * Secret Service cannot). False means the caller falls back to VEK-wrapped credentials and
	 * unlock-gated backups, which is how every other platform works.
	 */
	available(): Promise<boolean>;
	/**
	 * Store one target's secret fields, pinned to `origin` (`scheme://host[:port]`, from the
	 * endpoint or server URL the user configured). The pin is the load-bearing part: this side
	 * also names the URL of every later request, so without it a compromised caller could have
	 * the credential attached to a request at its own server and read it out of the log. Refusing
	 * to hand the secret back is not, on its own, containment.
	 */
	save(vaultId: string, targetId: string, secrets: BackupSecrets, origin: string): Promise<void>;
	/** Erase one target's credentials (target removed, or its vault deleted). */
	remove(vaultId: string, targetId: string): Promise<void>;
	/** A transport that authenticates with this target's stored credentials, in the host process. */
	transport(vaultId: string, target: BackupTargetConfig): BackupTransport;
	/**
	 * A transport for credentials this platform did NOT store: the caller passes the secrets it
	 * unwrapped from the vault. Needed because "can the credential store be used" and "can this
	 * platform reach a provider from its UI process" are separate questions, and on the desktop the
	 * answer to the second is no either way. Without this, a machine with no credential store would
	 * fall back to a `fetch` that cannot work, and every backup would fail.
	 */
	transportWithSecrets(target: BackupTargetConfig, secrets: BackupSecrets): BackupTransport;
}
