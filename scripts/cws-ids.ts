// Chrome Web Store identifiers, shared by the uploader (sign-cws.ts) and the release preflight
// (release.ts). Neither is secret: the item id is in every store URL for the extension, and the
// publisher id is the developer-account id from the dashboard.

export const CWS_ITEM_ID = process.env.CWS_ITEM_ID ?? "kmokhdhoggbdcgoepifeckhgbfakaknm";

// The v2 API is publisher-scoped: publishers/{PUBLISHER_ID}/items/{ITEM_ID}.
export const CWS_PUBLISHER_ID =
	process.env.CWS_PUBLISHER_ID ?? "38b433bd-8538-4d67-aedf-a1297d133309";
