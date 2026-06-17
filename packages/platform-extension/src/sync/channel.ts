// Turns a data channel's fire-and-forget send + push-based receive into an
// async request/response Channel, so request/reply protocols (the handshake) read
// as a straight-line await sequence instead of nested callbacks.

export interface Channel {
	send(data: string): void;
	/** Resolve with the next inbound message (queued if it already arrived). */
	recv(): Promise<string>;
}

export function makeChannel(send: (data: string) => void): {
	channel: Channel;
	push: (data: string) => void;
} {
	const queue: string[] = [];
	let waiting: ((data: string) => void) | null = null;
	return {
		channel: {
			send,
			recv: () =>
				new Promise((resolve) => {
					const next = queue.shift();
					if (next !== undefined) resolve(next);
					else waiting = resolve;
				}),
		},
		push: (data) => {
			if (waiting) {
				const resolve = waiting;
				waiting = null;
				resolve(data);
			} else {
				queue.push(data);
			}
		},
	};
}
