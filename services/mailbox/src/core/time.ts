export const DAY_MS = 86_400_000;

/** Whole days since the epoch: the coarse check-in day the device list shows. */
export const dayOf = (ms: number) => Math.floor(ms / DAY_MS);
