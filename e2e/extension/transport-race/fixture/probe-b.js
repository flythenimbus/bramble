// The control's B: go straight back, so A is asked to restore from the back/forward cache.
const probeB = new URLSearchParams(location.search);
const probeBKey = `probe-b:${probeB.get("run")}`;

addEventListener("load", () => {
	if (sessionStorage.getItem(probeBKey)) return;
	sessionStorage.setItem(probeBKey, "went-back");
	setTimeout(() => history.back(), 0);
});
