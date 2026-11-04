// Dev-only bridge that lets the e2e harness drive the desktop app's vault window.
//
// The harness POSTs code to /__bramble_e2e on the Vite dev server; the server relays it over its
// own HMR socket to src/e2e-bridge.ts in the window, which runs it and answers the same way.
// Guarded three ways: the plugin applies only to `vite serve`, mounts only when
// BRAMBLE_E2E_TOKEN holds a long per-run secret, and answers only requests that carry that secret
// and no Origin header (so no web page can reach it). src/e2e-bridge.test.ts proves none of it
// reaches a release build.

import { randomUUID, timingSafeEqual } from "node:crypto";

const MIN_TOKEN = 32;
const ANSWER_MS = 30_000;

function sameToken(given, expected) {
	if (typeof given !== "string" || given.length !== expected.length) return false;
	return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

export function e2eBridge() {
	return {
		name: "bramble-e2e-bridge",
		apply: "serve",
		configureServer(server) {
			const token = process.env.BRAMBLE_E2E_TOKEN;
			if (!token || token.length < MIN_TOKEN) return;
			const waiting = new Map();
			server.ws.on("bramble:e2e-result", (data) => {
				waiting.get(data?.id)?.(data);
				waiting.delete(data?.id);
			});
			server.middlewares.use("/__bramble_e2e", (req, res) => {
				const refuse = () => {
					res.statusCode = 403;
					res.end();
				};
				if (req.method !== "POST" || req.headers.origin !== undefined) return refuse();
				if (!sameToken(req.headers["x-bramble-e2e"], token)) return refuse();
				let body = "";
				req.on("data", (chunk) => {
					body += chunk;
				});
				req.on("end", () => {
					let code;
					try {
						code = JSON.parse(body).code;
					} catch {
						res.statusCode = 400;
						return res.end();
					}
					const id = randomUUID();
					const timer = setTimeout(() => {
						waiting.delete(id);
						res.statusCode = 504;
						res.end();
					}, ANSWER_MS);
					waiting.set(id, (answer) => {
						clearTimeout(timer);
						res.setHeader("content-type", "application/json");
						res.end(JSON.stringify(answer));
					});
					server.ws.send({ type: "custom", event: "bramble:e2e", data: { id, code } });
				});
			});
		},
	};
}
