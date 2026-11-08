// NIP-11 relay information, in parity with node/relay.mjs.

const INFO_TYPE = "application/nostr+json";

export function wantsRelayInfo(req: Request): boolean {
	return (
		req.method === "GET" &&
		req.headers.get("Upgrade") !== "websocket" &&
		(req.headers.get("Accept") ?? "").includes(INFO_TYPE)
	);
}

export function relayInfoResponse(limits: {
	maxMessageLength: number;
	maxSubscriptions: number;
}): Response {
	const info = {
		name: "Bramble signaling relay",
		description:
			"Forwards ephemeral events (kinds 20000-29999) to current subscribers. Stores nothing and does not verify signatures.",
		software: "https://github.com/flythenimbus/bramble",
		supported_nips: [1, 11],
		limitation: {
			max_message_length: limits.maxMessageLength,
			max_subscriptions: limits.maxSubscriptions,
			max_subid_length: 64,
			auth_required: false,
			payment_required: false,
			restricted_writes: true,
		},
	};
	return new Response(JSON.stringify(info), {
		headers: {
			"Content-Type": INFO_TYPE,
			"Access-Control-Allow-Origin": "*",
			"Access-Control-Allow-Headers": "*",
			"Access-Control-Allow-Methods": "GET",
		},
	});
}
