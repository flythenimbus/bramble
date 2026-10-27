// Backup credentials in the OS credential store, and the transport that uses them.
//
// Both halves live in the Rust shell for one reason each, and the reasons compound. The webview
// cannot reach a provider (no S3 endpoint or WebDAV server grants CORS to `tauri://localhost`),
// so the request has to be sent over there anyway; and once it is, the credential has no reason
// to come back here, so it stays in the keychain and this file only ever sends secrets INTO the
// shell. That is also what lets the scheduler honour a vault's timer while the vault is locked.
// See @core/adapters/backup-creds and docs/cloud-storage-backups.md.

import type { BackupCredentialsAdapter } from "@core/adapters/backup-creds";
import type { HttpBodySource } from "@core/adapters/http";
import type { BackupSecrets, BackupTargetConfig } from "@core/backup/config";
import type { BackupHttpResponse } from "@core/backup/types";
import { invoke } from "@tauri-apps/api/core";
import { streamInto } from "./stream";

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

/** JSON, UTF-8, then base64, so a header can carry a URL or header value that is not ASCII. */
function base64Json(value: unknown): string {
	const bytes = new TextEncoder().encode(JSON.stringify(value));
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary);
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
	}: {
		method: string;
		url: string;
		headers?: Record<string, string>;
		body?: Uint8Array | HttpBodySource;
	},
): Promise<BackupHttpResponse> {
	// A body goes as raw IPC bytes, with the rest of the request base64'd into one header (a raw
	// body leaves no JSON arguments). As a number array, a backup archive of up to
	// MAX_BACKUP_BYTES would be several hundred megabytes of JSON in this webview. Bodiless
	// requests (list, delete) keep the plain JSON path.
	const params = { vaultId, targetId, auth, method, url, headers: headers ?? {} };
	// Too large for one IPC call, and to a provider that cannot take it in parts (WebDAV): the
	// shell opens the request with the secret applied, and the body follows in chunks.
	if (body && !(body instanceof Uint8Array)) {
		const id = await invoke<number>("backup_stream_open", { ...params, size: body.size });
		const res = await streamInto<{ status: number; body: number[] }>(id, body);
		return {
			status: res.status,
			ok: res.status >= 200 && res.status < 300,
			body: Uint8Array.from(res.body),
		};
	}
	const res = body
		? await invoke<{ status: number; body: number[] }>("backup_send_raw", body, {
				headers: { "x-bramble-request": base64Json(params) },
			})
		: await invoke<{ status: number; body: number[] }>("backup_send", { ...params, body: null });
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
