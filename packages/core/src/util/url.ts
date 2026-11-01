/**
 * A stored website with its scheme. A bare host (`example.com`, `nas.local:5000`) is read as
 * https; left alone, `URL` throws on the first and takes `nas.local` for the second's scheme.
 */
export function withScheme(url: string): string {
	return /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`;
}
