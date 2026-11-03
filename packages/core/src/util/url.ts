/**
 * A stored website with its scheme. A bare host (`example.com`, `nas.local:5000`) is read as
 * https; left alone, `URL` throws on the first and takes `nas.local` for the second's scheme.
 */
export function withScheme(url: string): string {
	return /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`;
}

/**
 * The link "open website" follows for a stored website, or null when it isn't http(s): an app
 * URI, a typo, or a `javascript:`/`file:` value that must never become a clickable link.
 */
export function launchableUrl(url: string): string | null {
	try {
		const parsed = new URL(withScheme(url.trim()));
		return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
	} catch {
		return null;
	}
}
