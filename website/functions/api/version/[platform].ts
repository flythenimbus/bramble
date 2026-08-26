// Latest-version badges: GET /api/version/{android,desktop}. Shields' own release badge would
// print the whole tag (v0.15.0-android); the platform is already the label, so trim it here.
import { badge, json, type PagesContext, type ReleasePlatform, snapshot } from "../_github";

// simple-icons has no desktop glyph, so this one is Tabler's device-desktop (filled), the icon
// set the site already uses. White rather than currentColor, which shields renders as black.
const DESKTOP_ICON =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#fff"><path d="M7 21a1 1 0 0 1 0 -2h1v-2h-4a2 2 0 0 1 -2 -2v-10a2 2 0 0 1 2 -2h16a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-4v2h1a1 1 0 0 1 0 2zm7 -4h-4v2h4z"/></svg>';

const WINDOWS_ICON =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#fff"><path d="M21 13v5c0 1.57 -1.248 2.832 -2.715 2.923l-.113 .003l-.042 .018a1 1 0 0 1 -.336 .056l-.118 -.008l-4.676 -.585v-7.407zm-10 0v7.157l-5.3 -.662c-1.514 -.151 -2.7 -1.383 -2.7 -2.895v-3.6zm0 -9.158v7.158h-8v-3.6c0 -1.454 1.096 -2.648 2.505 -2.87zm10 2.058v5.1h-8v-7.409l4.717 -.589c1.759 -.145 3.283 1.189 3.283 2.898"/></svg>';

type Badge = { namedLogo?: string; logoSvg?: string; unreleased?: boolean };

const BADGES: Record<ReleasePlatform, Badge> = {
	android: { namedLogo: "android" },
	desktop: { logoSvg: DESKTOP_ICON },
	windows: { logoSvg: WINDOWS_ICON, unreleased: true },
};

export const onRequest = async (context: PagesContext): Promise<Response> => {
	const platform = String(context.params.platform ?? "").toLowerCase() as ReleasePlatform;
	if (!(platform in BADGES)) return json({ error: "unknown platform" }, 404, "no-store");

	const { unreleased, ...logo } = BADGES[platform];
	const latest = (await snapshot(context.env))?.latest[platform];

	// A platform with no build yet is not an outage: say so in grey rather than red.
	if (!latest && unreleased) {
		return badge({ label: platform, message: "coming soon", color: "lightgrey", ...logo }, 3600);
	}
	if (!latest) return badge({ label: platform, message: "unavailable", isError: true }, 300);

	return badge({ label: platform, message: `v${latest.version}`, color: "blue", ...logo }, 3600);
};
