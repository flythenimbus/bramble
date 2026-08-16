/**
 * What we can tell about the visitor's device, used to order the download options.
 *
 * Detection only ever reorders and relabels: every option stays rendered and reachable, and the
 * markup order is a sensible default on its own. So a wrong guess costs a click, and JS being off
 * costs nothing.
 */

export type Family = "chromium" | "gecko" | "webkit";
export type Os = "macos" | "linux" | "windows" | "ios" | "android" | "unknown";

export interface Platform {
	os: Os;
	family: Family;
	/** iOS or Android: the visitor wants an app, not a .dmg. */
	mobile: boolean;
}

/** The Client Hints surface, which only Chromium implements. Narrower than the real thing. */
interface UaData {
	platform?: string;
}

export function detect(ua: string = navigator.userAgent): Platform {
	const os = detectOs(ua);
	return { os, family: detectFamily(ua), mobile: os === "ios" || os === "android" };
}

function detectOs(ua: string): Os {
	// Client Hints where they exist: Chromium freezes the OS in the UA string but reports it
	// honestly here. Values are "macOS", "Windows", "Linux", "Android", "Chrome OS".
	const hint = (navigator as Navigator & { userAgentData?: UaData }).userAgentData?.platform;
	switch (hint?.toLowerCase()) {
		case "android":
			return "android";
		case "macos":
			return "macos";
		case "windows":
			return "windows";
		case "linux":
			return "linux";
	}

	if (/android/i.test(ua)) return "android";
	if (/iphone|ipad|ipod/i.test(ua)) return "ios";
	// An iPad has claimed to be a Macintosh since iPadOS 13, and touch points are the only thing
	// that gives it away. A Mac never reports more than one.
	if (/macintosh|mac os x/i.test(ua)) return navigator.maxTouchPoints > 1 ? "ios" : "macos";
	if (/windows/i.test(ua)) return "windows";
	if (/linux|x11|cros/i.test(ua)) return "linux";
	return "unknown";
}

function detectFamily(ua: string): Family {
	// Zen, LibreWolf and Waterfox all report a plain Firefox UA; Seamonkey borrows it and is not
	// one of us.
	if (/\bFirefox\/\d/.test(ua) && !/Seamonkey\//i.test(ua)) return "gecko";
	if (/Chrome\/|Chromium\/|CriOS\//.test(ua)) return "chromium";
	return "webkit";
}

/**
 * The browser by name, for "Add to Brave" rather than "Add to your browser".
 *
 * Async because Brave is: it hides itself from the user agent string and answers a promise
 * instead. Undefined when the browser is not one we can name (Safari, Arc), where the generic
 * label is the honest one.
 */
export async function browserName(ua: string = navigator.userAgent): Promise<string | undefined> {
	if (detectFamily(ua) === "gecko") {
		if (/Waterfox\//i.test(ua)) return "Waterfox";
		if (/LibreWolf\//i.test(ua)) return "LibreWolf";
		return "Firefox";
	}

	if (/Vivaldi\//.test(ua)) return "Vivaldi";
	if (/\bEdg(?:e|A|iOS)?\//.test(ua)) return "Edge";
	if (/\bOPR\//.test(ua)) return "Opera";

	const brave = (navigator as Navigator & { brave?: { isBrave?: () => Promise<boolean> } }).brave;
	if (typeof brave?.isBrave === "function") {
		try {
			return (await brave.isBrave()) ? "Brave" : "Chrome";
		} catch {
			return "Chrome";
		}
	}

	if (/\bChrome\//.test(ua)) return "Chrome";
	return undefined;
}
