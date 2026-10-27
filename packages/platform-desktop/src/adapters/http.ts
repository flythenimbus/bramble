// Outbound HTTP for hosts the webview cannot reach. `tauri://localhost` is granted CORS by
// nothing, so a request to a third party is sent from the Rust side, where there is no origin to
// refuse and no browser to enforce one. The two rules (no ambient cookies, no redirect following)
// are kept over there, in `net.rs`, because that is where the request actually happens.
// See @core/adapters/http and docs/email-aliases.md.

import type { HttpResponse, HttpTransport } from "@core/adapters/http";
import { invoke } from "@tauri-apps/api/core";

export const desktopHttp: HttpTransport = {
	async send({ method, url, headers, body }): Promise<HttpResponse> {
		// Alias providers' small JSON calls; a streamed body is a backup's, which goes through
		// backup-creds instead.
		if (body && !(body instanceof Uint8Array)) throw new Error("http_send takes a whole body");
		// Bytes ride as number arrays, as vault blobs and backup bodies already do over this IPC
		// (see adapters/storage and adapters/backup-creds): Tauri's channel is JSON.
		const res = await invoke<{ status: number; body: number[] }>("http_send", {
			method,
			url,
			headers: headers ?? {},
			body: body ? Array.from(body) : null,
		});
		return {
			status: res.status,
			ok: res.status >= 200 && res.status < 300,
			body: Uint8Array.from(res.body),
		};
	},
};
