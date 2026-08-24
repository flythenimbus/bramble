// Control for the bfcache case: the same navigate-away-and-back shape with no extension messaging
// at all. content.js no-ops without a `role` param, so this page holds nothing open. If even THIS
// is refused the back/forward cache, the browser or the machine it is on is declining outright and
// the real case never had a chance to prove anything.
const probeA = new URLSearchParams(location.search);
const probeARun = probeA.get("run");
const probeAKey = `probe-a:${probeARun}`;

function probeAReport(event) {
	navigator.sendBeacon(
		`${location.origin}/report?run=${encodeURIComponent(probeARun)}`,
		new Blob([JSON.stringify(event)], { type: "application/json" }),
	);
}

addEventListener(
	"pagehide",
	(pagehide) => probeAReport({ kind: "pagehide", role: "a", persisted: pagehide.persisted }),
	{
		once: true,
	},
);
addEventListener("pageshow", (page) => {
	if (page.persisted) probeAReport({ kind: "restored", role: "a" });
});

addEventListener("load", () => {
	if (sessionStorage.getItem(probeAKey)) return;
	sessionStorage.setItem(probeAKey, "navigated");
	// Well clear of the load turn. The real case reaches its navigation through an extension
	// round trip and a postMessage, which is plenty of time; a control that leaves the instant
	// load fires is refused the cache on a perfectly healthy browser, and would then blame the
	// machine for it.
	setTimeout(() => location.assign(`/probe-b?run=${encodeURIComponent(probeARun)}`), 250);
});
