// Bound a transport wait. The relay is best-effort live fan-out (ephemeral, no store) and
// relay channels have no close event, so a frame dropped mid-exchange would leave a recv()
// pending forever. Every wait that a peer can stall is wrapped in this.

export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
	});
	return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}
