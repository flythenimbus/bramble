/// <reference types="chrome" />

// One-click backup provider OAuth connect, run entirely in the background service
// worker. Doing it here (not the popup) is what makes it reliable: launchWebAuthFlow
// opens a provider window that steals focus, which closes the popup and destroys any
// context awaiting the result. The background survives that, and a keepalive holds it
// across the (possibly minutes-long, 2FA) sign-in. The resulting refresh token is
// VEK-wrapped via the offscreen host and persisted as a backup target, so it shows up
// whenever the popup is next opened. See docs/cloud-storage-backups.md.

import {
	BACKUP_TARGETS_KEY,
	type BackupTargetConfig,
	type WrappedCreds,
} from "@core/backup/config";
import {
	exchangeCodeForTokens,
	generatePkce,
	OAUTH_PROVIDERS,
	type OAuthProviderId,
} from "@core/backup/oauth";
import { api } from "../platform-api";
import { extensionStorage } from "../storage";
import { sendToOffscreen } from "./offscreen-client";
import { extensionOnly, type MessageEnvelope, on } from "./router";
import { getActiveVaultId, vaultLocked } from "./session";

// Reset the SW idle timer while an interactive auth is pending (under the 30s cutoff).
function keepAlive(): () => void {
	const id = setInterval(() => void api.runtime.getPlatformInfo().catch(() => {}), 20_000);
	return () => clearInterval(id);
}

// VEK-wrap the refresh token via the offscreen crypto host (same shape as useBackup.wrap). Tag
// the active vault so decryptSecrets can find the wrapping vek (it tries the active vault first).
async function wrapSecret(plaintext: string): Promise<WrappedCreds> {
	const res = await sendToOffscreen({
		type: "CRYPTO_ENCRYPT_OUTER",
		vaultId: getActiveVaultId() ?? undefined,
		payload: { plaintext },
	});
	if (!res.ok || !res.data || typeof res.data !== "object") {
		throw new Error("Couldn't secure the credentials.");
	}
	const { iv, ciphertext } = res.data as { iv: string; ciphertext: string };
	return { iv, ciphertext };
}

async function connectOAuth(message: {
	payload?: { providerId?: string; targetId?: string };
}): Promise<MessageEnvelope> {
	const providerId = message.payload?.providerId as OAuthProviderId | undefined;
	const targetId = message.payload?.targetId;
	if (!providerId || !OAUTH_PROVIDERS[providerId]) return { ok: false, error: "Unknown provider." };
	// Wrapping the refresh token needs the VEK, so the vault must be unlocked.
	if (vaultLocked()) return { ok: false, error: "Unlock Bramble first, then connect." };

	const meta = OAUTH_PROVIDERS[providerId];
	const redirectUri = api.identity.getRedirectURL();
	const pkce = await generatePkce();
	const state = crypto.randomUUID();

	const url = new URL(meta.authUrl);
	const p = url.searchParams;
	p.set("client_id", meta.clientId);
	p.set("response_type", "code");
	p.set("redirect_uri", redirectUri);
	p.set("scope", meta.scopes.join(" "));
	p.set("code_challenge", pkce.challenge);
	p.set("code_challenge_method", "S256");
	p.set("state", state);
	for (const [k, v] of Object.entries(meta.authParams ?? {})) p.set(k, v);

	const stop = keepAlive();
	let redirect: string | undefined;
	try {
		redirect = await api.identity.launchWebAuthFlow({ url: url.toString(), interactive: true });
	} catch (e) {
		return { ok: false, error: `Sign-in was cancelled or failed: ${(e as Error).message}` };
	} finally {
		stop();
	}
	if (!redirect) return { ok: false, error: "Sign-in was cancelled." };

	const back = new URL(redirect);
	// Providers return the code in the query; fall back to the fragment just in case.
	const params =
		back.searchParams.has("code") || back.searchParams.has("error")
			? back.searchParams
			: new URLSearchParams(back.hash.replace(/^#/, ""));
	const err = params.get("error_description") || params.get("error");
	if (err) return { ok: false, error: `Sign-in failed: ${err}` };
	if (params.get("state") !== state) {
		return { ok: false, error: "Sign-in could not be verified (state mismatch)." };
	}
	const code = params.get("code");
	if (!code) return { ok: false, error: "No authorization code was returned." };

	const tokens = await exchangeCodeForTokens({
		providerId,
		code,
		codeVerifier: pkce.verifier,
		redirectUri,
	});
	const creds = await wrapSecret(JSON.stringify({ refreshToken: tokens.refreshToken }));

	// Add a new target, or re-wrap an existing one's creds (reconnect).
	const list = (await extensionStorage.getMeta<BackupTargetConfig[]>(BACKUP_TARGETS_KEY)) ?? [];
	if (targetId && list.some((t) => t.id === targetId)) {
		await extensionStorage.setMeta(
			BACKUP_TARGETS_KEY,
			list.map((t) => (t.id === targetId ? { ...t, creds, lastError: undefined } : t)),
		);
		return { ok: true, data: { targetId } };
	}
	const id = crypto.randomUUID();
	const target: BackupTargetConfig = {
		id,
		providerId,
		provider: providerId,
		frequency: "daily",
		keep: 30,
		creds,
	};
	await extensionStorage.setMeta(BACKUP_TARGETS_KEY, [...list, target]);
	return { ok: true, data: { targetId: id } };
}

on(
	"BACKUP_OAUTH_CONNECT",
	extensionOnly((message) => connectOAuth(message as Parameters<typeof connectOAuth>[0])),
);
