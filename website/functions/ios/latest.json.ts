// GET /ios/latest.json: the version live on the App Store, which is not the newest upload (review
// and the release itself happen by hand in App Store Connect), so it is read from Apple.
import { edgeCached } from "../api/_cache";
import { json, type PagesContext } from "../api/_github";

const APP_ID = "6783071787";
const LOOKUP = `https://itunes.apple.com/lookup?id=${APP_ID}&country=us`;

type Listing = {
	version?: string;
	currentVersionReleaseDate?: string;
	releaseNotes?: string;
	trackViewUrl?: string;
	minimumOsVersion?: string;
};

async function readListing(): Promise<Listing> {
	const response = await fetch(LOOKUP, { headers: { "User-Agent": "bramble-website" } });
	if (!response.ok) throw new Error(`itunes ${response.status}`);
	const listing = ((await response.json()) as { results?: Listing[] }).results?.[0];
	if (!listing?.version) throw new Error("itunes: no listing");
	return listing;
}

export const onRequest = async (_context: PagesContext): Promise<Response> => {
	const listing = await edgeCached("https://bramble.sh/__cache/app-store", readListing);
	if (!listing) return json({ error: "unavailable" }, 503, "no-store");

	return json(
		{
			version: listing.version,
			pub_date: listing.currentVersionReleaseDate,
			notes: listing.releaseNotes,
			url: listing.trackViewUrl?.split("?")[0],
			minimum_os: listing.minimumOsVersion,
		},
		200,
		"public, max-age=300",
	);
};
