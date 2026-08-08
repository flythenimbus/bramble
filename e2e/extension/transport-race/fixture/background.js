// Test-only contract fixture: the production extension is never loaded here.
const extension = globalThis.browser ?? chrome;
let pending;

async function report(reportUrl, event) {
	await fetch(reportUrl, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(event),
	});
}

extension.runtime.onMessage.addListener((message, sender, sendResponse) => {
	if (message.type === "TRANSPORT_OBSERVE_DOCUMENT") {
		void report(message.reportUrl, {
			kind: "observed",
			role: message.role,
			documentNonce: message.documentNonce,
			frameId: sender.frameId,
		}).then(
			() => sendResponse({ ok: true }),
			() => sendResponse({ ok: false }),
		);
		return true;
	}

	if (message.type === "TRANSPORT_REQUEST") {
		pending = {
			documentNonce: message.documentNonce,
			frameId: sender.frameId,
			reportUrl: message.reportUrl,
			releaseUrl: message.releaseUrl,
			sendResponse,
		};
		void poll();
		return true; // exactly the primitive Bramble uses: async sendResponse.
	}

	return false;
});

async function poll() {
	while (pending) {
		try {
			const response = await fetch(pending.releaseUrl, { cache: "no-store" });
			if (response.ok && (await response.text()) === "release") {
				const reply = pending;
				pending = undefined;
				reply.sendResponse({ sentinel: "BRAMBLE_TRANSPORT_SENTINEL" });
				void report(reply.reportUrl, {
					kind: "reply-sent",
					role: "a",
					documentNonce: reply.documentNonce,
					frameId: reply.frameId,
				});
				return;
			}
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}
