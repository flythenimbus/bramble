// Backup credentials in the OS credential store, and the transport that uses them.
//
// Both halves live in the Rust shell for one reason each, and the reasons compound. The webview
// cannot reach a provider (no S3 endpoint or WebDAV server grants CORS to `tauri://localhost`),
// so the request has to be sent over there anyway; and once it is, the credential has no reason
// to come back here, so it stays in the keychain and this file only ever sends secrets INTO the
// shell. That is also what lets the scheduler honour a vault's timer while the vault is locked.
// See @core/adapters/backup-creds and docs/cloud-storage-backups.md.

import type { BackupCredentialsAdapter } from "@core/adapters/backup-creds";
import type { BackupTargetConfig } from "@core/backup/config";
import type { BackupHttpResponse } from "@core/backup/types";
import { invoke } from "@tauri-apps/api/core";

/** Which secret the shell should apply, decided by the provider kind. */
function authFor(target: BackupTargetConfig): { kind: "s3"; region: string } | { kind: "basic" } {
	return target.provider === "s3" ? { kind: "s3", region: target.region ?? "" } : { kind: "basic" };
}

export const desktopBackupCreds: BackupCredentialsAdapter = {
	available: () => invoke<boolean>("backup_creds_available"),

	save: (vaultId, targetId, secrets) =>
		invoke<void>("backup_creds_save", { vaultId, targetId, secrets: JSON.stringify(secrets) }),

	remove: (vaultId, targetId) => invoke<void>("backup_creds_remove", { vaultId, targetId }),

	transport: (vaultId, target) => ({
		async send({ method, url, headers, body }): Promise<BackupHttpResponse> {
			// Bytes ride as number arrays, as vault blobs already do over this IPC (see
			// adapters/storage): Tauri's channel is JSON, and a snapshot is small enough that the
			// overhead is not what makes a backup slow.
			const res = await invoke<{ status: number; body: number[] }>("backup_send", {
				vaultId,
				targetId: target.id,
				auth: authFor(target),
				method,
				url,
				headers: headers ?? {},
				body: body ? Array.from(body) : null,
			});
			return {
				status: res.status,
				ok: res.status >= 200 && res.status < 300,
				body: Uint8Array.from(res.body),
			};
		},
	}),
};
