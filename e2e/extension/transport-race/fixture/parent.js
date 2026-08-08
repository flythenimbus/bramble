const params = new URLSearchParams(location.search);
const run = params.get("run");
const mode = params.get("mode");
const frame = document.createElement("iframe");
frame.src = `/child?run=${encodeURIComponent(run)}&role=a`;
document.body.append(frame);

let originalWindow;
let navigated = false;
let wentBack = false;
addEventListener("message", (event) => {
	if (event.data?.run !== run) return;
	if (event.data.kind === "a-ready" && !navigated) {
		navigated = true;
		originalWindow = frame.contentWindow;
		const host =
			mode === "cross-origin"
				? location.hostname === "127.0.0.1"
					? "localhost"
					: "127.0.0.1"
				: location.hostname;
		frame.src = `http://${host}:${location.port}/child?run=${encodeURIComponent(run)}&role=b`;
		return;
	}

	if (event.data.kind !== "b-ready") return;
	void fetch(`/report?run=${encodeURIComponent(run)}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ kind: "frame", reused: originalWindow === frame.contentWindow }),
	});
	if (mode === "bfcache" && !wentBack) {
		wentBack = true;
		frame.contentWindow.history.back();
	}
});
