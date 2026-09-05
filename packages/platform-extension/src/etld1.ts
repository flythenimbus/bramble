// Minimal eTLD+1 without the tldts PSL table.
//
// The background service worker previously imported `tldts.getDomain`, which
// pulls the whole public-suffix list into the cold-start bundle of the most
// frequently woken context (every AUTOFILL_QUERY wakes the SW). Autofill only
// needs "same registrable domain" for the default `etld1` policy, and WebAuthn
// only needs "is this rpId a bare public suffix". Both are answered here with
// a ~30-entry two-level-suffix table + last-two-labels fallback: bytes, not
// hundreds of KB, and zero parse cost at SW wake.
//
// Behaviour vs tldts: identical for single-level TLDs (`mail.google.com` ->
// `google.com`), IPs / localhost / single labels fall back to the raw input
// (exact match). Multi-level suffixes outside the table (rare: e.g.
// `*.ck`, `*.kobe.jp`) degrade to last-two-labels, i.e. a *narrower* match,
// which fails closed (fewer fill suggestions, never more).

const TWO_LEVEL_SUFFIXES = new Set([
	"co.uk",
	"org.uk",
	"me.uk",
	"ac.uk",
	"gov.uk",
	"co.jp",
	"or.jp",
	"ne.jp",
	"ac.jp",
	"go.jp",
	"com.au",
	"net.au",
	"org.au",
	"co.nz",
	"co.kr",
	"or.kr",
	"com.br",
	"com.cn",
	"com.mx",
	"com.ar",
	"co.in",
	"co.za",
	"com.tr",
	"co.il",
]);

function splitLabels(hostname: string): string[] | null {
	const host = hostname.toLowerCase().replace(/\.+$/, "");
	if (!host || host.includes(" ") || host.includes("_")) return null;
	// IPv4 / IPv6 literals and single labels are not registrable domains.
	if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":") || !host.includes(".")) {
		return null;
	}
	const labels = host.split(".");
	if (labels.some((l) => l.length === 0 || l.length > 63)) return null;
	return labels;
}

/**
 * eTLD+1 of a hostname, or null when it is itself a public suffix
 * (`com`, `co.uk`) or unparseable (IP, localhost). Null is the "fail closed"
 * signal: callers fall back to exact match / reject the rpId.
 */
export function etld1(hostname: string): string | null {
	const labels = splitLabels(hostname);
	if (!labels || labels.length < 2) return null;
	const last2 = labels.slice(-2).join(".");
	if (TWO_LEVEL_SUFFIXES.has(last2)) {
		if (labels.length === 2) return null; // bare public suffix, e.g. `co.uk`
		return labels.slice(-3).join(".");
	}
	return last2;
}
