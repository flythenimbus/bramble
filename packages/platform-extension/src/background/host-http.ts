/// <reference types="chrome" />

// The background's HttpTransport for backups: each request runs in the crypto host as a job (see
// http-host.ts), because a Chrome service worker cannot hold one open for a large upload.

import { bodyToBlob, type HttpTransport } from "@core/adapters/http";
import { base64ToBytes, bytesToBase64 } from "@core/util/bytes";
import { dropHandoff, putHandoff } from "../files/idb";
import type { HttpJobRequest, HttpJobState } from "../http-host";
import { sendToOffscreen } from "./offscreen-client";

/** Bodies up to this size go inline in the message; larger ones by handoff. */
const INLINE_MAX = 256 * 1024;
const POLL_MS = 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const hostHttp: HttpTransport = {
	async send({ method, url, headers, body }) {
		let handoff: string | null = null;
		let jobBody: HttpJobRequest["body"];
		if (body instanceof Uint8Array && body.length <= INLINE_MAX) {
			jobBody = { inline: bytesToBase64(body) };
		} else if (body) {
			handoff = await putHandoff(
				body instanceof Uint8Array ? new Blob([body as BlobPart]) : await bodyToBlob(body),
			);
			jobBody = { handoff };
		}
		try {
			const started = await sendToOffscreen({
				type: "HTTP_JOB_START",
				payload: { method, url, headers, body: jobBody } satisfies HttpJobRequest,
			});
			if (!started.ok || typeof started.data !== "string") {
				throw new Error(started.error ?? "the request could not be started");
			}
			for (;;) {
				await sleep(POLL_MS);
				const polled = await sendToOffscreen({
					type: "HTTP_JOB_POLL",
					payload: { id: started.data },
				});
				if (!polled.ok) throw new Error(polled.error ?? "the request was lost");
				const state = polled.data as HttpJobState;
				if (!state.done) continue;
				if ("error" in state) throw new Error(state.error);
				return {
					status: state.status,
					ok: state.status >= 200 && state.status < 300,
					body: base64ToBytes(state.body),
				};
			}
		} finally {
			if (handoff) await dropHandoff(handoff).catch(() => {});
		}
	},
};
