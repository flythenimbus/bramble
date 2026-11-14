// GET /android/latest.json: the newest Android release, read from GitHub like the badges.
import { json, type PagesContext, snapshot } from "../api/_github";

export const onRequest = async (context: PagesContext): Promise<Response> => {
	const latest = (await snapshot(context.env))?.latest.android;
	if (!latest?.installer) return json({ error: "unavailable" }, 503, "no-store");

	return json(
		{
			version: latest.version,
			pub_date: latest.publishedAt,
			url: latest.installer.url,
			sha256: latest.installer.sha256,
			size: latest.installer.size,
			release_url: latest.url,
		},
		200,
		"public, max-age=300",
	);
};
