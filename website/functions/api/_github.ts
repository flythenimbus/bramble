// One cached view of every GitHub release, shared by the badge and redirect endpoints.
// Underscore-prefixed, so Pages treats this as a module rather than a route.

export type Env = { GITHUB_TOKEN?: string };

export type PagesContext = {
	request: Request;
	env: Env;
	params: Record<string, string | string[]>;
};

/** Platforms that ship installers of their own, and so have download counts. */
export type DownloadPlatform = "android" | "macos" | "linux";

/** Platforms that are released under their own tag, and so have a version. */
export type ReleasePlatform = "android" | "desktop";

export type Latest = { tag: string; version: string; url: string };

export type Snapshot = {
	downloads: Record<DownloadPlatform, number>;
	latest: Partial<Record<ReleasePlatform, Latest>>;
};

type Release = {
	tag_name?: string;
	html_url?: string;
	draft?: boolean;
	assets?: Array<{ name?: string; download_count?: number }>;
};

export const REPO = "flythenimbus/bramble";
export const RELEASES_URL = `https://github.com/${REPO}/releases`;

// Installers only: no SHA256SUMS, no .sig, no Bramble.app.tar.gz (the auto-updater artifact).
const INSTALLERS: Record<DownloadPlatform, RegExp> = {
	android: /\.apk$/i,
	macos: /\.dmg$/i,
	linux: /\.(appimage|deb|rpm)$/i,
};

// Tags are `0.15.0-android`, `0.5.0-desktop`, `1.19.0-chromium`, and so on.
const TAGS: Record<ReleasePlatform, RegExp> = {
	android: /^(.+)-android$/i,
	desktop: /^(.+)-desktop$/i,
};

// Refetch after an hour; keep the last good numbers for a month to serve if GitHub is unhappy.
const FRESH_MS = 60 * 60 * 1000;
const STALE_SECONDS = 30 * 24 * 60 * 60;
const CACHE_KEY = "https://bramble.sh/__cache/releases";

/** Edge-cached, refreshed hourly, falling back to the stale copy when GitHub fails. */
export async function snapshot(env: Env): Promise<Snapshot | null> {
	const cache = (caches as any).default as Cache;
	const key = new Request(CACHE_KEY);
	const hit = await cache.match(key);
	const cached = hit ? ((await hit.json()) as { stored: number; snapshot: Snapshot }) : null;
	if (cached && Date.now() - cached.stored < FRESH_MS) return cached.snapshot;

	try {
		const fresh = await readReleases(env);
		await cache.put(
			key,
			new Response(JSON.stringify({ stored: Date.now(), snapshot: fresh }), {
				headers: { "Cache-Control": `public, max-age=${STALE_SECONDS}` },
			}),
		);
		return fresh;
	} catch {
		return cached?.snapshot ?? null;
	}
}

async function readReleases(env: Env): Promise<Snapshot> {
	const result: Snapshot = { downloads: { android: 0, macos: 0, linux: 0 }, latest: {} };
	const headers: Record<string, string> = {
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
		"User-Agent": "bramble-website-badges",
	};
	if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;

	for (let page = 1; page <= 10; page++) {
		const url = `https://api.github.com/repos/${REPO}/releases?per_page=100&page=${page}`;
		const response = await fetch(url, { headers });
		if (!response.ok) throw new Error(`github ${response.status}`);
		const releases = (await response.json()) as Release[];

		// GitHub returns newest first, so the first tag that matches a platform is its latest.
		for (const release of releases) {
			if (release.draft) continue;

			for (const platform of Object.keys(TAGS) as ReleasePlatform[]) {
				const version = release.tag_name?.match(TAGS[platform])?.[1];
				if (version && !result.latest[platform]) {
					result.latest[platform] = {
						tag: release.tag_name as string,
						version,
						url: release.html_url ?? RELEASES_URL,
					};
				}
			}

			for (const asset of release.assets ?? []) {
				for (const platform of Object.keys(INSTALLERS) as DownloadPlatform[]) {
					if (asset.name && INSTALLERS[platform].test(asset.name)) {
						result.downloads[platform] += asset.download_count ?? 0;
					}
				}
			}
		}

		if (releases.length < 100) break;
	}

	return result;
}

/** A shields.io endpoint badge: https://shields.io/badges/endpoint-badge */
export function badge(
	fields: {
		label: string;
		message: string;
		color?: string;
		namedLogo?: string;
		logoSvg?: string;
		logoColor?: string;
		isError?: boolean;
	},
	cacheSeconds: number,
): Response {
	// flat-square across the row, so the README badges read as one set with the Matrix one.
	return json(
		{ schemaVersion: 1, style: "flat-square", cacheSeconds, ...fields },
		200,
		`public, max-age=${cacheSeconds}`,
	);
}

export function json(body: unknown, status: number, cacheControl: string): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json",
			"Cache-Control": cacheControl,
			"Access-Control-Allow-Origin": "*",
		},
	});
}
