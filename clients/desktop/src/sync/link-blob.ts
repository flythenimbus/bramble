// Browsers on this machine as file peers, over the native-messaging link. The stream logic is
// @core/sync/transport/blob-link; this is only the app's half of the pipe, relayed by socket.rs,
// which sends no file frame to a browser until that browser has said it speaks files.

import { blobLinkListener, type LinkBrowser } from "@core/sync/transport/blob-link";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface FrameEvent extends LinkBrowser {
	stream: number;
	frame: string;
}

export const linkBlobSource = blobLinkListener({
	send: (peerId, stream, frame) => invoke<void>("link_blob_send", { peerId, stream, frame }),
	poke: (peerId) => invoke<void>("link_blob_poke", { peerId }),
	peers: () => invoke<LinkBrowser[]>("link_blob_peers"),
	subscribe: async ({ capable, gone, frame }) => {
		const unlisteners = [
			await listen<LinkBrowser>("link-blob-capable", (e) => capable(e.payload)),
			await listen<LinkBrowser>("link-peer-disconnected", (e) => gone(e.payload)),
			await listen<FrameEvent>("link-blob-frame", (e) => {
				const { peerId, link, stream, frame: f } = e.payload;
				frame({ peerId, link }, stream, f);
			}),
		];
		return () => {
			for (const un of unlisteners) un();
		};
	},
});
