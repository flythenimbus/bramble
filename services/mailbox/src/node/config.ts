// The self-hosted server's environment, validated with zod. A bad value stops the server before it
// listens, and the message names the variable, never its value (one of them is a secret).

import { z } from "zod";

export const ConfigSchema = z.object({
	PORT: z.coerce.number().int().min(0).max(65535).default(7401),
	DATA_DIR: z.string().min(1).default("./data"),
	/** The RELAY_TOKEN rule: at least 16 URL-safe characters. */
	MAILBOX_TOKEN: z
		.string()
		.regex(/^[A-Za-z0-9_-]{16,}$/)
		.optional(),
	RETENTION_MAX_DAYS: z.coerce.number().int().min(1).max(3650).default(365),
	QUOTA_BYTES: z.coerce.number().int().positive().optional(),
});

export interface Config {
	port: number;
	dataDir: string;
	token: string | null;
	retentionMaxDays: number;
	quotaBytes: number | null;
}

export class ConfigError extends Error {
	constructor(variable: string) {
		super(`Invalid ${variable}; see services/mailbox/README.md`);
		this.name = "ConfigError";
	}
}

export function parseConfig(env: Record<string, string | undefined>): Config {
	// An empty variable means unset, as it does to a shell.
	const present = Object.fromEntries(
		Object.keys(ConfigSchema.shape)
			.map((k) => [k, env[k]] as const)
			.filter(([, v]) => v !== undefined && v !== ""),
	);
	const parsed = ConfigSchema.safeParse(present);
	if (!parsed.success)
		throw new ConfigError(String(parsed.error.issues[0]?.path[0] ?? "configuration"));
	const c = parsed.data;
	return {
		port: c.PORT,
		dataDir: c.DATA_DIR,
		token: c.MAILBOX_TOKEN ?? null,
		retentionMaxDays: c.RETENTION_MAX_DAYS,
		quotaBytes: c.QUOTA_BYTES ?? null,
	};
}
