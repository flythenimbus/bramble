import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { Db } from "../core/app.ts";
import * as schema from "../core/schema.ts";

const MIGRATIONS = fileURLToPath(new URL("../../drizzle", import.meta.url));

/** Open (or create) the SQLite file and bring it to the current schema. */
export function openDb(file: string): { db: Db; close(): void } {
	const sqlite = new Database(file);
	if (file !== ":memory:") sqlite.pragma("journal_mode = WAL");
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle({ client: sqlite, schema });
	migrate(db, { migrationsFolder: MIGRATIONS });
	return { db, close: () => sqlite.close() };
}
