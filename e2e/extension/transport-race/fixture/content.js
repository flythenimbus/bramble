(() => {
	const extension = globalThis.browser ?? chrome;
	const params = new URLSearchParams(location.search);
	const run = params.get("run");
	const role = params.get("role");
	const documentNonce = crypto.randomUUID();
	const reportUrl = `${location.origin}/report?run=${encodeURIComponent(run)}`;

	if (role !== "a" && role !== "b") return;

	function event(kind, extra = {}) {
		return { kind, role, documentNonce, ...extra };
	}

	function report(kind, extra = {}) {
		return fetch(reportUrl, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(event(kind, extra)),
			keepalive: true,
		}).catch(() => {});
	}

	function reportOnPagehide(pagehide) {
		navigator.sendBeacon(
			reportUrl,
			new Blob([JSON.stringify(event("pagehide", { persisted: pagehide.persisted }))], {
				type: "application/json",
			}),
		);
	}

	async function documentComplete() {
		if (document.readyState === "complete") return;
		await new Promise((resolve) => addEventListener("load", resolve, { once: true }));
	}

	let cancelled = false;
	addEventListener(
		"pagehide",
		(pagehide) => {
			cancelled = true;
			reportOnPagehide(pagehide);
		},
		{ once: true },
	);
	addEventListener("pageshow", (page) => {
		if (page.persisted) void report("restored");
	});

	void (async () => {
		await extension.runtime.sendMessage({
			type: "TRANSPORT_OBSERVE_DOCUMENT",
			role,
			documentNonce,
			reportUrl,
		});
		await report("loaded");

		if (role === "b") {
			await documentComplete();
			parent.postMessage({ kind: "b-ready", run }, "*");
			return;
		}
		if (role !== "a") return;

		const request = extension.runtime.sendMessage({
			type: "TRANSPORT_REQUEST",
			documentNonce,
			releaseUrl: `${location.origin}/release?run=${encodeURIComponent(run)}`,
			reportUrl,
		});
		await documentComplete();
		parent.postMessage({ kind: "a-ready", run }, location.origin);
		try {
			const reply = await request;
			if (!cancelled) await report("applied", { sentinel: reply?.sentinel });
		} catch {
			if (!cancelled) await report("closed");
		}
	})();
})();
