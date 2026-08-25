// Latest-version badges: GET /api/version/{android,desktop}. Shields' own release badge would
// print the whole tag (v0.15.0-android); the platform is already the label, so trim it here.
import { badge, json, type PagesContext, type ReleasePlatform, snapshot } from "../_github";

// simple-icons has no desktop glyph, so this one is Tabler's device-desktop (filled), the icon
// set the site already uses. White rather than currentColor, which shields renders as black.
const DESKTOP_ICON =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#fff"><path d="M7 21a1 1 0 0 1 0 -2h1v-2h-4a2 2 0 0 1 -2 -2v-10a2 2 0 0 1 2 -2h16a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-4v2h1a1 1 0 0 1 0 2zm7 -4h-4v2h4z"/></svg>';

const BADGES: Record<ReleasePlatform, { namedLogo?: string; logoSvg?: string }> = {
	android: { namedLogo: "android" },
	desktop: { logoSvg: DESKTOP_ICON },
};

export const onRequest = async (context: PagesContext): Promise<Response> => {
	const platform = String(context.params.platform ?? "").toLowerCase() as ReleasePlatform;
	if (!(platform in BADGES)) return json({ error: "unknown platform" }, 404, "no-store");

	const latest = (await snapshot(context.env))?.latest[platform];
	if (!latest) return badge({ label: platform, message: "unavailable", isError: true }, 300);

	return badge(
		{ label: platform, message: `v${latest.version}`, color: "blue", ...BADGES[platform] },
		3600,
	);
};
