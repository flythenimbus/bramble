const bfcacheA = new URLSearchParams(location.search);
const bfcacheAKey = `bfcache-a:${bfcacheA.get("run")}`;

addEventListener("message", (event) => {
	if (
		sessionStorage.getItem(bfcacheAKey) ||
		event.data?.kind !== "a-ready" ||
		event.data.run !== bfcacheA.get("run")
	)
		return;
	sessionStorage.setItem(bfcacheAKey, "navigated");
	location.assign(`/top-b?run=${encodeURIComponent(bfcacheA.get("run"))}&mode=bfcache&role=b`);
});
