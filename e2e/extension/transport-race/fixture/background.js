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
		// Tell the sender the request has LANDED, without answering it. A document that navigates
		// with an extension message still in flight is refused the back/forward cache by Firefox
		// 128; one whose message is already parked here is not. The reply itself stays held, which
		// is the thing under test - only the delivery is confirmed. See content.js.
		if (sender.tab?.id !== undefined) {
			void extension.tabs.sendMessage(
				sender.tab.id,
				{ type: "TRANSPORT_REQUEST_PARKED", documentNonce: message.documentNonce },
				{ frameId: sender.frameId },
			);
		}
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
