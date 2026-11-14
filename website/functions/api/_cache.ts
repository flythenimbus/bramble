// Refetch after an hour; keep the last good copy for a month to serve if the upstream is unhappy.
const FRESH_MS = 60 * 60 * 1000;
const STALE_SECONDS = 30 * 24 * 60 * 60;

/** Edge-cached under `key`, refreshed hourly, falling back to the stale copy when `load` fails. */
export async function edgeCached<T>(key: string, load: () => Promise<T>): Promise<T | null> {
	const cache = (caches as any).default as Cache;
	const request = new Request(key);
	const hit = await cache.match(request);
	const cached = hit ? ((await hit.json()) as { stored: number; value: T }) : null;
	if (cached && Date.now() - cached.stored < FRESH_MS) return cached.value;

	try {
		const fresh = await load();
		await cache.put(
			request,
			new Response(JSON.stringify({ stored: Date.now(), value: fresh }), {
				headers: { "Cache-Control": `public, max-age=${STALE_SECONDS}` },
			}),
		);
		return fresh;
	} catch {
		return cached?.value ?? null;
	}
}
