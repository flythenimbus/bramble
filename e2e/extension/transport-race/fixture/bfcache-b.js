const bfcacheB = new URLSearchParams(location.search);
const bfcacheBKey = `bfcache-b:${bfcacheB.get("run")}`;

addEventListener("message", (event) => {
	if (
		sessionStorage.getItem(bfcacheBKey) ||
		event.data?.kind !== "b-ready" ||
		event.data.run !== bfcacheB.get("run")
	)
		return;
	sessionStorage.setItem(bfcacheBKey, "went-back");
	history.back();
});
