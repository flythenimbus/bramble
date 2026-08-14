// Backup credentials in the OS credential store, and the transport that uses them.
//
// Both halves live in the Rust shell for one reason each, and the reasons compound. The webview
// cannot reach a provider (no S3 endpoint or WebDAV server grants CORS to `tauri://localhost`),
// so the request has to be sent over there anyway; and once it is, the credential has no reason
// to come back here, so it stays in the keychain and this file only ever sends secrets INTO the
// shell. That is also what lets the scheduler honour a vault's timer while the vault is locked.
// See @core/adapters/backup-creds and docs/cloud-storage-backups.md.

import type { BackupCredentialsAdapter } from "@core/adapters/backup-creds";
import type { BackupSecrets, BackupTargetConfig } from "@core/backup/config";
import type { BackupHttpResponse } from "@core/backup/types";
import { invoke } from "@tauri-apps/api/core";

/** Which stored secret the shell should apply, decided by the provider kind. */
function authFor(target: BackupTargetConfig): { kind: "s3"; region: string } | { kind: "basic" } {
	return target.provider === "s3" ? { kind: "s3", region: target.region ?? "" } : { kind: "basic" };
}

/** The same, for a secret the caller unwrapped from the vault (no credential store here). */
function inlineAuthFor(target: BackupTargetConfig, secrets: BackupSecrets) {
	if (target.provider === "s3") {
		const s = secrets as { accessKeyId: string; secretAccessKey: string };
		return {
			kind: "s3Inline" as const,
			region: target.region ?? "",
			accessKeyId: s.accessKeyId,
			secretAccessKey: s.secretAccessKey,
		};
	}
	const s = secrets as { username: string; password: string };
	return { kind: "basicInline" as const, username: s.username, password: s.password };
}

/** One authenticated request through the shell. `auth` decides where the secret comes from. */
async function send(
	vaultId: string,
	targetId: string,
	auth: unknown,
	{
		method,
		url,
		headers,
		body,
	}: { method: string; url: string; headers?: Record<string, string>; body?: Uint8Array },
): Promise<BackupHttpResponse> {
	// Bytes ride as number arrays, as vault blobs already do over this IPC (see adapters/storage):
	// Tauri's channel is JSON, and a snapshot is small enough that the overhead is not what makes
	// a backup slow.
	const res = await invoke<{ status: number; body: number[] }>("backup_send", {
		vaultId,
		targetId,
		auth,
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
}

export const desktopBackupCreds: BackupCredentialsAdapter = {
	// The shell picks its own store (Secret Service, else kernel keyutils, else nothing) and this
	// only reports the consequence. "kernel" is not surfaced separately: it backs up on schedule
	// just the same, and the difference (gone after a reboot rather than after logout) is not
	// something to put in front of anyone.
	async status() {
		const tier = await invoke<"os" | "kernel" | "none">("backup_creds_tier");
		return tier === "none"
			? { unattended: false, reason: "no-credential-store" as const }
			: { unattended: true };
	},

	save: (vaultId, targetId, secrets, origin) =>
		invoke<void>("backup_creds_save", {
			vaultId,
			targetId,
			origin,
			secrets: JSON.stringify(secrets),
		}),

	remove: (vaultId, targetId) => invoke<void>("backup_creds_remove", { vaultId, targetId }),

	transport: (vaultId, target) => ({
		send: (req) => send(vaultId, target.id, authFor(target), req),
	}),

	// No vault id: nothing is read from the credential store on this path, so there is nothing to
	// scope. The secret came from the vault the caller already had open.
	transportWithSecrets: (target, secrets) => ({
		send: (req) => send("", target.id, inlineAuthFor(target, secrets), req),
	}),
};
