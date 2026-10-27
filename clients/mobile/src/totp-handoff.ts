import { App as CapacitorApp } from "@capacitor/app";

// An `otpauth://` key the OS hands us: iOS routes it here when Bramble is the app picked
// under Settings > Apps > Passwords > "Set Up Codes In", Android when the user picks
// Bramble from the chooser for an otpauth:// link. Registration is the whole mechanism on
// both (a CFBundleURLTypes entry, an intent filter); there is no API for either list.
// See docs/totp-uri-handler.md.
//
// Two delivery paths, because one is not enough, the same shape the credential-exchange
// handoff has. The event covers an app that is already running. At a COLD launch the URL
// is delivered before the webview exists, so that event fires into nothing and the launch
// URL has to be pulled instead.

const SCHEME = /^otpauth:\/\//i;

// `getLaunchUrl()` is NOT one-shot: it reports the URL that started this process for the
// process's whole lifetime, and on Android a recreated activity is re-delivered its
// original intent. So it is read once (a memoized promise) and handed to at most one
// subscriber, or a resume would replay a key the user already placed or declined.
//
// Delivery is marked only once a LIVE subscriber has taken it, so a subscriber that tears
// down before the read resolves leaves the key for the next one rather than eating it.
let launchUrlOnce: Promise<string | undefined> | null = null;
let launchUrlDelivered = false;

function readLaunchUrl(): Promise<string | undefined> {
	launchUrlOnce ??= CapacitorApp.getLaunchUrl()
		.then((r) => r?.url)
		.catch(() => undefined);
	return launchUrlOnce;
}

/**
 * Subscribe to handed-over authenticator keys. Fires for the cold-launch URL once, then
 * for every URL opened while running. Non-`otpauth://` URLs are ignored: Bramble
 * registers no other scheme, but the listener is shared with anything Capacitor routes.
 * Returns an unsubscribe.
 */
export function onTotpHandoff(cb: (uri: string) => void): () => void {
	let live = true;
	const deliver = (url: string | undefined) => {
		if (live && url && SCHEME.test(url)) cb(url);
	};

	if (!launchUrlDelivered) {
		void readLaunchUrl().then((url) => {
			if (!live || launchUrlDelivered) return;
			launchUrlDelivered = true;
			deliver(url);
		});
	}

	const handle = CapacitorApp.addListener("appUrlOpen", ({ url }) => deliver(url));
	return () => {
		live = false;
		void handle.then((h) => h.remove()).catch(() => {});
	};
}

/** Test seam: forget the launch URL was read, so each test starts at a cold launch. */
export function resetLaunchUrlForTest(): void {
	launchUrlOnce = null;
	launchUrlDelivered = false;
}
