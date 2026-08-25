// Download-count badges, summed across every release: GET /api/downloads/{android,macos,linux}.
// Shields can only sum an exact asset name, and ours carry a version (bramble_android_0.15.0.apk).
import { badge, type DownloadPlatform, json, type PagesContext, snapshot } from "../_github";

const BADGES: Record<DownloadPlatform, { namedLogo: string; logoColor?: string }> = {
	android: { namedLogo: "android" },
	macos: { namedLogo: "apple", logoColor: "white" },
	linux: { namedLogo: "linux", logoColor: "white" },
};

export const onRequest = async (context: PagesContext): Promise<Response> => {
	const platform = String(context.params.platform ?? "").toLowerCase() as DownloadPlatform;
	if (!(platform in BADGES)) return json({ error: "unknown platform" }, 404, "no-store");

	const releases = await snapshot(context.env);
	if (!releases) {
		return badge({ label: platform, message: "unavailable", isError: true }, 300);
	}

	const count = releases.downloads[platform];
	return badge(
		{
			label: platform,
			message: `${metric(count)} downloads`,
			color: color(count),
			...BADGES[platform],
		},
		3600,
	);
};

/** The shading shields uses on its own download badges: red at nothing, brightgreen at 1k. */
function color(count: number): string {
	if (count >= 1000) return "brightgreen";
	if (count >= 100) return "green";
	if (count >= 10) return "yellowgreen";
	if (count >= 1) return "yellow";
	return "red";
}

/** 1234 -> 1.2k, the same shape shields prints for its own download counts. */
function metric(value: number): string {
	const units = ["k", "M", "G"];
	let scaled = value;
	let unit = -1;
	while (scaled >= 1000 && unit < units.length - 1) {
		scaled /= 1000;
		unit++;
	}
	if (unit < 0) return String(value);
	return `${scaled >= 100 ? Math.round(scaled) : Math.round(scaled * 10) / 10}${units[unit]}`;
}
