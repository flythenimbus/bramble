/**
 * The site an alias is for, from whatever the user typed: a URL or a bare domain. Providers put it
 * in the alias's description (and SimpleLogin in the address), so it is identifiable later.
 * Undefined for anything that does not parse as one.
 */
export function aliasSiteOf(input: string | undefined): string | undefined {
	const text = input?.trim();
	if (!text) return undefined;
	try {
		return new URL(/^https?:/i.test(text) ? text : `https://${text}`).hostname || undefined;
	} catch {
		return undefined;
	}
}
