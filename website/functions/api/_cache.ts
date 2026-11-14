// Upstream answers (GitHub's releases, Apple's listing), refreshed hourly and kept so a failed
// refresh serves the last good copy.
//
// Two layers, because the Cache API is per Cloudflare location: a location that had never served
// the route, and whose one upstream call failed, had nothing to fall back on and answered 503.
// KV is global, so any location that ever succeeded covers the rest.

/** The slice of a KV binding this uses, so the functions need no workers-types. */
type Kv = {
	get(key: string, type: "json"): Promise<unknown>;
	put(key: string, value: string): Promise<void>;
};

export type CacheEnv = { RELEASES_KV?: Kv };

type Entry<T> = { stored: number; value: T };

const FRESH_MS = 60 * 60 * 1000;
/** How long a location keeps its own copy, as the fallback of last resort. */
const STALE_SECONDS = 30 * 24 * 60 * 60;

const isFresh = (e: Entry<unknown> | null): boolean => !!e && Date.now() - e.stored < FRESH_MS;

export async function edgeCached<T>(
	env: CacheEnv,
	key: string,
	load: () => Promise<T>,
): Promise<T | null> {
	const cache = (caches as any).default as Cache;
	const request = new Request(`https://bramble.sh/__cache/${key}`);
	const hit = await cache.match(request);
	const local = hit ? ((await hit.json()) as Entry<T>) : null;
	if (local && isFresh(local)) return local.value;

	const global = ((await env.RELEASES_KV?.get(key, "json").catch(() => null)) ??
		null) as Entry<T> | null;
	if (global && isFresh(global)) {
		await keepLocally(cache, request, global);
		return global.value;
	}

	try {
		const entry = { stored: Date.now(), value: await load() };
		await Promise.all([
			keepLocally(cache, request, entry),
			env.RELEASES_KV?.put(key, JSON.stringify(entry)),
		]);
		return entry.value;
	} catch (e) {
		console.error(`${key}: refresh failed: ${e instanceof Error ? e.message : String(e)}`);
		const stale = [local, global]
			.filter((x): x is Entry<T> => !!x)
			.sort((a, b) => b.stored - a.stored)[0];
		return stale?.value ?? null;
	}
}

function keepLocally(cache: Cache, request: Request, entry: Entry<unknown>): Promise<void> {
	return cache.put(
		request,
		new Response(JSON.stringify(entry), {
			headers: { "Cache-Control": `public, max-age=${STALE_SECONDS}` },
		}),
	);
}
