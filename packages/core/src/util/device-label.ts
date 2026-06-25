// A coarse, no-prompt default name for this device's roster entry, so a synced
// group lists "Android device" / "Firefox on Mac" instead of every member showing
// the same "This device". Derived from the user agent (a real string in every host:
// the extension popup, the mobile webview). The roster CRDT propagates whatever a
// device stamps for itself, so this is what peers see; "this device" in the UI is
// matched by public key, not by label, so a collision here is only cosmetic.

export function defaultDeviceLabel(ua: string = navigatorUa()): string {
	if (/android/i.test(ua)) return "Android device";
	if (/iphone/i.test(ua)) return "iPhone";
	if (/ipad/i.test(ua)) return "iPad";
	const browser = /firefox/i.test(ua)
		? "Firefox"
		: /edg\//i.test(ua)
			? "Edge"
			: /chrome/i.test(ua)
				? "Chrome"
				: /safari/i.test(ua)
					? "Safari"
					: "Browser";
	if (/macintosh|mac os x/i.test(ua)) return `${browser} on Mac`;
	if (/windows/i.test(ua)) return `${browser} on Windows`;
	if (/linux/i.test(ua)) return `${browser} on Linux`;
	return browser === "Browser" ? "This device" : browser;
}

function navigatorUa(): string {
	return typeof navigator !== "undefined" ? navigator.userAgent : "";
}
