// Stable links to whatever the newest release is: /latest/{android,desktop}. Lets the README and
// the site point at "the latest Android build" without editing a pinned tag on every release.
import {
	json,
	type PagesContext,
	RELEASES_URL,
	type ReleasePlatform,
	snapshot,
} from "../api/_github";

const PLATFORMS: ReleasePlatform[] = ["android", "desktop"];

export const onRequest = async (context: PagesContext): Promise<Response> => {
	const platform = String(context.params.platform ?? "").toLowerCase() as ReleasePlatform;
	if (!PLATFORMS.includes(platform)) return json({ error: "unknown platform" }, 404, "no-store");

	// The full list is a better answer than a 404 when GitHub is unreachable.
	const latest = (await snapshot(context.env))?.latest[platform];
	return new Response(null, {
		status: 302,
		headers: {
			Location: latest?.url ?? RELEASES_URL,
			"Cache-Control": latest ? "public, max-age=3600" : "no-store",
		},
	});
};
