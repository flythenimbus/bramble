import { type CacheEnv, edgeCached } from "./_cache";

// One cached view of every GitHub release, shared by the badge and redirect endpoints.
// Underscore-prefixed, so Pages treats this as a module rather than a route.

export type Env = CacheEnv & { GITHUB_TOKEN?: string };

export type PagesContext = {
	request: Request;
	env: Env;
	params: Record<string, string | string[]>;
};

/** Platforms that ship installers of their own, and so have download counts. */
export type DownloadPlatform = "android" | "macos" | "linux";

/** Platforms that are released under their own tag, and so have a version. */
export type ReleasePlatform = "android" | "desktop" | "windows";

/** `url` is the release page; `installer` is the file itself, where the platform has one. */
export type Latest = {
	tag: string;
	version: string;
	url: string;
	publishedAt?: string;
	installer?: { url: string; sha256?: string; size?: number };
};

export type Snapshot = {
	downloads: Record<DownloadPlatform, number>;
	latest: Partial<Record<ReleasePlatform, Latest>>;
};

type Release = {
	tag_name?: string;
	html_url?: string;
	published_at?: string;
	draft?: boolean;
	assets?: Array<{
		name?: string;
		download_count?: number;
		browser_download_url?: string;
		digest?: string;
		size?: number;
	}>;
};

export const REPO = "bramble-sh/bramble";
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
	// Nothing matches this yet. It is here so the badge reports a version by itself the day a
	// Windows build is tagged, rather than staying "coming soon" until someone notices.
	windows: /^(.+)-windows$/i,
};

// v2: a cached v1 snapshot has no installer, so it is not read back as one.
export const snapshot = (env: Env): Promise<Snapshot | null> =>
	edgeCached(env, "releases-v2", () => readReleases(env));

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
					const file =
						platform in INSTALLERS
							? release.assets?.find(
									(a) => a.name && INSTALLERS[platform as DownloadPlatform].test(a.name),
								)
							: undefined;
					result.latest[platform] = {
						tag: release.tag_name as string,
						version,
						url: release.html_url ?? RELEASES_URL,
						publishedAt: release.published_at,
						installer: file?.browser_download_url
							? {
									url: file.browser_download_url,
									sha256: file.digest?.replace(/^sha256:/, ""),
									size: file.size,
								}
							: undefined,
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
