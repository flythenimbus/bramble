import { useCallback, useEffect, useState } from "react";
import { createTarget, runBackup } from "../backup";
import {
	BACKUP_CONFIG_KEY,
	BACKUP_TARGETS_KEY,
	type BackupFrequency,
	type BackupSecrets,
	type BackupTargetConfig,
	backupPrefix,
	type DropboxSecrets,
	toProviderConfig,
} from "../backup/config";
import {
	exchangeCodeForTokens,
	generatePkce,
	OAUTH_PROVIDERS,
	type OAuthProviderId,
} from "../backup/oauth";
import { usePlatform } from "../context/PlatformContext";

export interface SaveTargetInput {
	providerId: string;
	provider: "s3" | "webdav" | "dropbox";
	endpoint?: string;
	region?: string;
	bucket?: string;
	prefix?: string;
	serverUrl?: string;
	path?: string;
	secrets?: BackupSecrets; // omit on edit to keep the saved credentials
}

const newId = () => globalThis.crypto.randomUUID();

/**
 * Manual cloud backup across many device-local targets, each with credentials
 * VEK-wrapped. Scheduling (Phase 1) rides on top of the same targets. Uploads run
 * in this UI context; on the extension a popup fetch reaches any provider via host
 * permissions. See docs/cloud-storage-backups.md.
 */
export function useBackup() {
	const { storage, crypto, shell } = usePlatform();
	// undefined = still loading.
	const [targets, setTargets] = useState<BackupTargetConfig[] | undefined>(undefined);
	const [runningIds, setRunningIds] = useState<ReadonlySet<string>>(() => new Set());

	const reload = useCallback(async () => {
		let list = await storage.getMeta<BackupTargetConfig[]>(BACKUP_TARGETS_KEY);
		if (!list) {
			// Migrate a legacy single-target config into the array (unreleased format).
			const legacy = await storage.getMeta<Omit<BackupTargetConfig, "id">>(BACKUP_CONFIG_KEY);
			list = legacy ? [{ ...legacy, id: newId() }] : [];
			if (legacy) {
				await storage.setMeta(BACKUP_TARGETS_KEY, list);
				await storage.removeMeta(BACKUP_CONFIG_KEY);
			}
		}
		setTargets(list);
	}, [storage]);

	useEffect(() => {
		void reload();
	}, [reload]);

	const persist = useCallback(
		async (next: BackupTargetConfig[]) => {
			await storage.setMeta(BACKUP_TARGETS_KEY, next);
			setTargets(next);
		},
		[storage],
	);

	const wrap = useCallback(
		async (secrets: BackupSecrets) => {
			const w = await crypto.encryptWithVek(JSON.stringify(secrets));
			return { iv: w.iv, ciphertext: w.ciphertext };
		},
		[crypto],
	);

	const addTarget = useCallback(
		async (input: SaveTargetInput) => {
			if (!input.secrets) throw new Error("Enter your credentials.");
			const target: BackupTargetConfig = {
				id: newId(),
				providerId: input.providerId,
				provider: input.provider,
				endpoint: input.endpoint,
				region: input.region,
				bucket: input.bucket,
				prefix: input.prefix,
				serverUrl: input.serverUrl,
				path: input.path,
				frequency: "daily",
				keep: 30,
				creds: await wrap(input.secrets),
			};
			await persist([...(targets ?? []), target]);
		},
		[wrap, persist, targets],
	);

	const updateTarget = useCallback(
		async (id: string, input: SaveTargetInput) => {
			const list = targets ?? [];
			const cur = list.find((t) => t.id === id);
			if (!cur) return;
			// A new credential pair re-wraps; omitting them keeps the saved ones.
			const creds = input.secrets ? await wrap(input.secrets) : cur.creds;
			const updated: BackupTargetConfig = {
				...cur,
				providerId: input.providerId,
				provider: input.provider,
				endpoint: input.endpoint,
				region: input.region,
				bucket: input.bucket,
				prefix: input.prefix,
				serverUrl: input.serverUrl,
				path: input.path,
				creds,
			};
			await persist(list.map((t) => (t.id === id ? updated : t)));
		},
		[wrap, persist, targets],
	);

	const setFrequency = useCallback(
		async (id: string, frequency: BackupFrequency) => {
			await persist((targets ?? []).map((t) => (t.id === id ? { ...t, frequency } : t)));
		},
		[persist, targets],
	);

	// Connect a one-click OAuth provider: run the interactive authorize step (platform-owned),
	// exchange the code for a refresh token, then add a new target or (targetId given) re-wrap an
	// existing one's credentials in place. Throws if the platform can't run the flow.
	const connectOAuth = useCallback(
		async (oauthId: OAuthProviderId, opts?: { targetId?: string }) => {
			if (!shell.runOAuthFlow) throw new Error("One-click sign-in isn't available here.");
			const meta = OAUTH_PROVIDERS[oauthId];
			const pkce = await generatePkce();
			const { code, redirectUri } = await shell.runOAuthFlow({
				authUrl: meta.authUrl,
				clientId: meta.clientId,
				scopes: meta.scopes,
				codeChallenge: pkce.challenge,
				state: newId(),
				extraParams: meta.authParams,
			});
			const tokens = await exchangeCodeForTokens({
				providerId: oauthId,
				code,
				codeVerifier: pkce.verifier,
				redirectUri,
			});
			const secrets: DropboxSecrets = { refreshToken: tokens.refreshToken };
			if (opts?.targetId) {
				const list = targets ?? [];
				const creds = await wrap(secrets);
				await persist(
					list.map((t) => (t.id === opts.targetId ? { ...t, creds, lastError: undefined } : t)),
				);
			} else {
				await addTarget({ providerId: oauthId, provider: oauthId, secrets });
			}
		},
		[shell, targets, wrap, persist, addTarget],
	);

	const removeTarget = useCallback(
		async (id: string) => {
			await persist((targets ?? []).filter((t) => t.id !== id));
		},
		[persist, targets],
	);

	// Back up to one target (id given) or all of them. Reads the vault blob once and
	// runs the targets concurrently; each records its own success/failure.
	const backupNow = useCallback(
		async (id?: string) => {
			const list = targets ?? [];
			const toRun = id ? list.filter((t) => t.id === id) : list;
			if (toRun.length === 0) return;
			const blob = await storage.readVaultBlob();
			setRunningIds(new Set(toRun.map((t) => t.id)));
			const results = await Promise.all(
				toRun.map(async (t) => {
					try {
						const secrets = JSON.parse(
							await crypto.decryptWithVek(t.creds.iv, t.creds.ciphertext),
						) as BackupSecrets;
						const bt = createTarget(toProviderConfig(t, secrets));
						const r = await runBackup(bt, blob, { prefix: backupPrefix(t), keep: t.keep });
						return {
							id: t.id,
							hash: r.hash as string | undefined,
							error: undefined as string | undefined,
						};
					} catch (e) {
						return { id: t.id, hash: undefined, error: (e as Error).message };
					}
				}),
			);
			const byId = new Map(results.map((r) => [r.id, r]));
			const now = Date.now();
			await persist(
				list.map((t) => {
					const r = byId.get(t.id);
					if (!r) return t;
					return r.error !== undefined
						? { ...t, lastError: r.error }
						: { ...t, lastBackupAt: now, lastVaultHash: r.hash, lastError: undefined };
				}),
			);
			setRunningIds(new Set());
		},
		[targets, storage, crypto, persist],
	);

	return {
		targets,
		runningIds,
		addTarget,
		updateTarget,
		setFrequency,
		removeTarget,
		backupNow,
		connectOAuth,
		// Whether this platform can run the interactive OAuth step at all (extension yes, mobile no).
		oauthAvailable: Boolean(shell.runOAuthFlow),
	};
}
