// The background's HLC clock, mirroring the popup's. Corner-prompt writes happen
// in the background (no popup), so they need their own stamps from the same
// device id. See docs/p2p-sync.md and @core/sync.

import { ensureDeviceId, type Hlc, type HybridClock, makeClock } from "@core/sync";
import { extensionStorage } from "../storage";

let clockPromise: Promise<HybridClock> | null = null;

function getClock(): Promise<HybridClock> {
	if (!clockPromise) {
		clockPromise = (async () => {
			const id = await ensureDeviceId(
				(k) => extensionStorage.getMeta<string>(k),
				(k, v) => extensionStorage.setMeta<string>(k, v),
			);
			return makeClock(id);
		})();
	}
	return clockPromise;
}

/** A fresh stamp for a background write. */
export async function nextStamp(): Promise<Hlc> {
	return (await getClock()).send();
}

/** Advance the background clock past a stamp read from disk. */
export async function witnessStamp(hlc: Hlc): Promise<void> {
	(await getClock()).witness(hlc);
}

/** Advance the background clock past every one of these stamps. */
export async function witnessStamps(stamps: Hlc[]): Promise<void> {
	const clock = await getClock();
	for (const hlc of stamps) clock.witness(hlc);
}
