import { useCallback, useEffect, useState } from "react";
import { createTarget, runBackup } from "../backup";
import {
	BACKUP_CONFIG_KEY,
	type BackupFrequency,
	type BackupSecrets,
	backupPrefix,
	type StoredBackupConfig,
	toProviderConfig,
} from "../backup/config";
import { usePlatform } from "../context/PlatformContext";

export interface SaveBackupInput {
	providerId: string;
	provider: "s3" | "webdav";
	endpoint?: string;
	region?: string;
	bucket?: string;
	prefix?: string;
	serverUrl?: string;
	path?: string;
	secrets?: BackupSecrets; // omit to keep the currently-saved credentials
}

/**
 * Manual cloud backup: persist a provider config (credentials VEK-wrapped) and
 * run a one-off backup. Scheduling (Phase 1) rides on top of the same config.
 * The upload runs in this UI context; on the extension its host permissions let
 * a popup fetch reach any provider. See docs/cloud-storage-backups.md.
 */
export function useBackup() {
	const { storage, crypto } = usePlatform();
	// undefined = still loading; null = no provider configured.
	const [config, setConfig] = useState<StoredBackupConfig | null | undefined>(undefined);
	const [running, setRunning] = useState(false);

	const reload = useCallback(async () => {
		setConfig((await storage.getMeta<StoredBackupConfig>(BACKUP_CONFIG_KEY)) ?? null);
	}, [storage]);

	useEffect(() => {
		void reload();
	}, [reload]);

	const persist = useCallback(
		async (next: StoredBackupConfig) => {
			await storage.setMeta(BACKUP_CONFIG_KEY, next);
			setConfig(next);
		},
		[storage],
	);

	const save = useCallback(
		async (input: SaveBackupInput) => {
			// New credentials get VEK-wrapped; if none were entered (an edit of only
			// non-secret fields) keep the ones already saved.
			const creds = input.secrets
				? await crypto
						.encryptWithVek(JSON.stringify(input.secrets))
						.then((w) => ({ iv: w.iv, ciphertext: w.ciphertext }))
				: config?.creds;
			if (!creds) throw new Error("Enter your credentials.");
			await persist({
				providerId: input.providerId,
				provider: input.provider,
				endpoint: input.endpoint,
				region: input.region,
				bucket: input.bucket,
				prefix: input.prefix,
				serverUrl: input.serverUrl,
				path: input.path,
				frequency: config?.frequency ?? "daily",
				keep: config?.keep ?? 30,
				creds,
			});
		},
		[crypto, persist, config],
	);

	const remove = useCallback(async () => {
		await storage.removeMeta(BACKUP_CONFIG_KEY);
		setConfig(null);
	}, [storage]);

	const setFrequency = useCallback(
		async (frequency: BackupFrequency) => {
			if (config) await persist({ ...config, frequency });
		},
		[config, persist],
	);

	const backupNow = useCallback(async () => {
		if (!config) throw new Error("No backup provider is set up.");
		setRunning(true);
		try {
			const secrets = JSON.parse(
				await crypto.decryptWithVek(config.creds.iv, config.creds.ciphertext),
			) as BackupSecrets;
			const target = createTarget(toProviderConfig(config, secrets));
			const blob = await storage.readVaultBlob();
			const result = await runBackup(target, blob, {
				prefix: backupPrefix(config),
				keep: config.keep,
			});
			await persist({
				...config,
				lastBackupAt: Date.now(),
				lastVaultHash: result.hash,
				lastError: undefined,
			});
			return result;
		} catch (e) {
			await persist({ ...config, lastError: (e as Error).message });
			throw e;
		} finally {
			setRunning(false);
		}
	}, [config, crypto, storage, persist]);

	return { config, running, save, remove, setFrequency, backupNow };
}
