import type { Hlc } from "./hlc";

/** Identifies one version of an entry: its id plus the stamp it was written with. */
export const entryVersionKey = (e: { id: string; hlc: Hlc }): string =>
	`${e.id}|${e.hlc.wall}|${e.hlc.counter}|${e.hlc.node}`;
