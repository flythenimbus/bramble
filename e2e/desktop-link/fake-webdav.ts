import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Just enough of a WebDAV server to take a backup, and to show the password it came with. Nothing
 * else reads a carried target's credentials for real, and they only open under the right key.
 */
export async function fakeWebDav() {
	const files = new Map<string, Buffer>();
	const auths = new Set<string>();
	const response = (path: string, size?: number) =>
		`<d:response><d:href>${path}</d:href><d:propstat><d:prop>${
			size === undefined
				? "<d:resourcetype><d:collection/></d:resourcetype>"
				: `<d:getcontentlength>${size}</d:getcontentlength>`
		}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
	const server = createServer((req, res) => {
		const cors = {
			"Access-Control-Allow-Origin": "*",
			"Access-Control-Allow-Methods": req.headers["access-control-request-method"] ?? "*",
			"Access-Control-Allow-Headers": req.headers["access-control-request-headers"] ?? "*",
		};
		const send = (status: number, body = "") => res.writeHead(status, cors).end(body);
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			if (req.method === "OPTIONS") return send(204);
			auths.add(req.headers.authorization ?? "");
			const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
			switch (req.method) {
				case "MKCOL":
					return send(201);
				case "PUT":
					files.set(path, Buffer.concat(chunks));
					return send(201);
				case "MOVE": {
					const to = new URL(String(req.headers.destination)).pathname;
					files.set(decodeURIComponent(to), files.get(path) ?? Buffer.alloc(0));
					files.delete(path);
					return send(201);
				}
				case "DELETE":
					files.delete(path);
					return send(204);
				case "GET": {
					const file = files.get(path);
					return file ? res.writeHead(200, cors).end(file) : send(404);
				}
				case "PROPFIND": {
					const one = files.get(path);
					const listed = one
						? response(path, one.length)
						: [...files]
								.filter(([name]) => name.startsWith(path))
								.map(([name, body]) => response(name, body.length))
								.join("") + response(path);
					return send(207, `<d:multistatus xmlns:d="DAV:">${listed}</d:multistatus>`);
				}
				default:
					return send(405);
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://localhost:${port}/dav/`,
		/** Finished snapshots: an upload counts once it is moved into place. */
		snapshots: () => [...files.keys()].filter((name) => name.endsWith(".bramble")),
		/** Every Authorization header any request came with. */
		auths: () => [...auths],
		close: () => new Promise((resolve) => server.close(resolve)),
	};
}

export const basicAuth = (user: string, password: string) =>
	`Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
