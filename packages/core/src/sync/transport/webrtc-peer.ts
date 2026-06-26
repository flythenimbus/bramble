// One WebRTC connection to a single remote peer (dev sync spike). The initiator
// creates the data channel and offer; the responder answers. ICE is host-candidate
// only (same-network v1, no STUN/TURN). SDP/ICE are emitted via onSignal and fed
// back in via handleSignal; the relay carries them (see sync-host.ts). Lives in the
// offscreen document because RTCPeerConnection needs a DOM context. See docs/p2p-sync.md.

export type PeerSignal =
	| { kind: "offer"; sdp: string }
	| { kind: "answer"; sdp: string }
	| { kind: "candidate"; candidate: RTCIceCandidateInit };

export interface Peer {
	handleSignal(signal: PeerSignal): Promise<void>;
	send(data: string): void;
	close(): void;
}

export interface PeerCallbacks {
	/** True for the side that creates the offer + data channel (deterministic, see sync-host). */
	initiator: boolean;
	iceServers?: RTCIceServer[];
	onSignal(signal: PeerSignal): void;
	onOpen(): void;
	onMessage(data: string): void;
	onClose(): void;
	/** ICE/connection state transitions, surfaced for diagnostics (e.g. an ICE stall that
	 * would otherwise hang silently at "initiating"). */
	onState?(state: string): void;
}

export function createPeer({
	initiator,
	iceServers,
	onSignal,
	onOpen,
	onMessage,
	onClose,
	onState,
}: PeerCallbacks): Peer {
	const pc = new RTCPeerConnection({ iceServers: iceServers ?? [] });
	let channel: RTCDataChannel | null = null;
	let remoteSet = false;
	// addIceCandidate before the remote description is set throws; buffer until then.
	const pendingCandidates: RTCIceCandidateInit[] = [];

	const wire = (ch: RTCDataChannel) => {
		channel = ch;
		ch.onopen = () => onOpen();
		ch.onmessage = (e) => onMessage(typeof e.data === "string" ? e.data : "");
		ch.onclose = () => onClose();
	};

	let localCandidates = 0;
	pc.onicecandidate = (e) => {
		if (e.candidate) {
			localCandidates++;
			onSignal({ kind: "candidate", candidate: e.candidate.toJSON() });
		} else {
			onState?.(`gathered ${localCandidates} candidate(s)`);
		}
	};
	pc.onconnectionstatechange = () => {
		onState?.(`conn ${pc.connectionState}`);
		if (pc.connectionState === "failed" || pc.connectionState === "closed") onClose();
	};
	// ICE failing is distinct from the overall connection failing and surfaces sooner;
	// report each transition and tear down on failure so a stuck connect never hangs silently.
	pc.oniceconnectionstatechange = () => {
		onState?.(`ice ${pc.iceConnectionState}`);
		if (pc.iceConnectionState === "failed") onClose();
	};

	if (initiator) {
		wire(pc.createDataChannel("sync"));
		void (async () => {
			try {
				const offer = await pc.createOffer();
				await pc.setLocalDescription(offer);
				if (offer.sdp) onSignal({ kind: "offer", sdp: offer.sdp });
				onState?.("offer sent");
			} catch (e) {
				onState?.(`offer error: ${(e as Error).message}`);
			}
		})();
	} else {
		pc.ondatachannel = (e) => wire(e.channel);
	}

	const flushCandidates = async () => {
		remoteSet = true;
		for (const c of pendingCandidates.splice(0)) {
			await pc.addIceCandidate(c).catch(() => {});
		}
	};

	return {
		async handleSignal(signal) {
			try {
				if (signal.kind === "offer") {
					onState?.("offer received");
					await pc.setRemoteDescription({ type: "offer", sdp: signal.sdp });
					await flushCandidates();
					const answer = await pc.createAnswer();
					await pc.setLocalDescription(answer);
					if (answer.sdp) onSignal({ kind: "answer", sdp: answer.sdp });
					onState?.("answer sent");
				} else if (signal.kind === "answer") {
					await pc.setRemoteDescription({ type: "answer", sdp: signal.sdp });
					await flushCandidates();
					onState?.("answer applied");
				} else if (remoteSet) {
					await pc.addIceCandidate(signal.candidate).catch(() => {});
				} else {
					pendingCandidates.push(signal.candidate);
				}
			} catch (e) {
				onState?.(`signal error (${signal.kind}): ${(e as Error).message}`);
			}
		},
		send(data) {
			if (channel?.readyState === "open") channel.send(data);
		},
		close() {
			try {
				channel?.close();
			} catch {}
			pc.close();
		},
	};
}
