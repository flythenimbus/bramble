// Bound a wait that something outside our control could stall forever. Two callers so far:
// relay channels have no close event, so a frame dropped mid-exchange leaves recv() pending;
// and a native plugin call that never calls back leaves its promise pending the same way.
// The label is user-visible - it names WHICH step stalled, which is the whole point.

export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
	});
	return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}
