import { getDomain } from "tldts";

/** Use the full PSL, including wildcard and exception rules. Callers rely on this
 * boundary for credential isolation and must not approximate it with fewer labels. */
export function etld1(hostname: string): string | null {
	return getDomain(hostname);
}
