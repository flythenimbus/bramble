// Request bodies the server stores without reading: a message's sealed envelope or a file blob,
// streamed into the BodyStore, capped at the declared length and checked against a hash on the way.

import type { Context } from "hono";
import type { AppDeps, Env } from "./app.ts";
import { HttpError } from "./auth.ts";
import { HashMismatchError } from "./bodies.ts";

class TooLargeError extends Error {}

/** Passes bytes through, refusing more than `limit`, and counts what actually arrived. */
function capped(limit: number) {
	let seen = 0;
	const stream = new TransformStream<Uint8Array, Uint8Array>({
		transform(piece, controller) {
			seen += piece.byteLength;
			if (seen > limit) controller.error(new TooLargeError());
			else controller.enqueue(piece);
		},
	});
	return { stream, received: () => seen };
}

/** The request's content-length: required, so size and quota are checked before reading a byte. */
export function declaredLength(c: Context<Env>, max: number): number {
	const declared = Number(c.req.header("content-length"));
	if (!Number.isSafeInteger(declared) || declared < 0) throw new HttpError(400, "bad_request");
	if (declared > max) throw new HttpError(413, "too_large");
	return declared;
}

/**
 * Stream the body into `key`, refusing bytes that do not hash to `sha256` (answered with
 * `mismatch`) or that run past `declared`. Returns how many bytes arrived.
 */
export async function storeUpload(
	deps: AppDeps,
	c: Context<Env>,
	key: string,
	declared: number,
	sha256: string,
	mismatch: HttpError,
): Promise<number> {
	const counter = capped(declared);
	const body = c.req.raw.body ?? new Response(new Uint8Array()).body!;
	try {
		await deps.bodies.put(key, body.pipeThrough(counter.stream), { sha256 });
	} catch (err) {
		if (err instanceof HashMismatchError) throw mismatch;
		if (err instanceof TooLargeError) throw new HttpError(413, "too_large");
		throw err;
	}
	return counter.received();
}
