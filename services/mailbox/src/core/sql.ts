// D1 caps a query at 100 bound parameters, and this core runs on D1 as well as SQLite, so every
// list that can grow past that is split with chunk().

export const MAX_PARAMS = 100;
/** An IN list's share once a query's other parameters (mailbox, member) are bound. */
export const IN_LIST = 90;

export function chunk<T>(items: readonly T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

/** Rows per multi-row insert into a table written with `columns` columns. */
export const rowsPerInsert = (columns: number) => Math.floor(MAX_PARAMS / columns);
