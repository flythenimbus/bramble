// Test-only: an in-memory server with a fake clock, and devices that sign requests the way the
// apps will (an Ed25519 roster key over canonicalRequest).

import type { webcrypto } from "node:crypto";
import { canonicalRequest, HEADERS, sha256Hex } from "@vault/core/src/sync/mailbox/protocol.ts";
import { type AppDeps, createApp } from "../core/app.ts";
import { type BodyStore, HashMismatchError } from "../core/bodies.ts";
import { openDb } from "../node/db.ts";

async function collect(body: ReadableStream<Uint8Array> | Uint8Array): Promise<Uint8Array> {
	if (body instanceof Uint8Array) return body;
	return new Uint8Array(await new Response(body).arrayBuffer());
}

export function memoryBodies(): BodyStore {
	const store = new Map<string, { bytes: Uint8Array; modifiedAt: number }>();
	return {
		async put(key, body, opts) {
			const bytes = await collect(body);
			if (opts?.sha256 && (await sha256Hex(bytes)) !== opts.sha256) throw new HashMismatchError();
			store.set(key, { bytes, modifiedAt: Date.now() });
		},
		async get(key) {
			const hit = store.get(key);
			if (!hit) return null;
			return {
				body: new Response(hit.bytes as Uint8Array<ArrayBuffer>).body!,
				size: hit.bytes.length,
			};
		},
		async delete(key) {
			store.delete(key);
		},
		async *keys() {
			for (const [key, { modifiedAt }] of store) yield { key, modifiedAt };
		},
	};
}

export interface ServerOpts {
	quotaBytes?: number;
	token?: string;
	retentionMaxDays?: number;
	canPost?: boolean;
}

export function makeServer(opts: ServerOpts = {}) {
	const clock = { now: 1_800_000_000_000 };
	const { db } = openDb(":memory:");
	const deps: AppDeps = {
		db,
		bodies: memoryBodies(),
		entitlement: { canPost: async () => opts.canPost ?? true },
		now: () => clock.now,
		config: {
			retentionMaxDays: opts.retentionMaxDays ?? 365,
			quotaBytes: opts.quotaBytes ?? null,
			token: opts.token ?? null,
		},
	};
	return { app: createApp(deps), deps, clock };
}

export type TestServer = ReturnType<typeof makeServer>;

export interface RequestOpts {
	time?: number;
	token?: string;
}

const b64 = (bytes: ArrayBuffer | Uint8Array) =>
	Buffer.from(bytes as ArrayBuffer).toString("base64");

/** A device with its own Ed25519 key, signing against the server's fake clock. */
export async function makeDevice(server: TestServer) {
	const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
		"sign",
		"verify",
	])) as unknown as webcrypto.CryptoKeyPair;
	const sigKey = b64(await crypto.subtle.exportKey("raw", pair.publicKey));

	async function headers(method: string, path: string, bytes: Uint8Array, opts: RequestOpts = {}) {
		const time = opts.time ?? server.clock.now;
		const contentSha256 = await sha256Hex(bytes);
		const message = new TextEncoder().encode(
			canonicalRequest({ method, pathAndQuery: path, time, contentSha256 }),
		);
		const sig = b64(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, message));
		const out: Record<string, string> = {
			[HEADERS.key]: sigKey,
			[HEADERS.time]: String(time),
			[HEADERS.contentSha256]: contentSha256,
			[HEADERS.sig]: sig,
		};
		if (opts.token) out[HEADERS.token] = opts.token;
		return out;
	}

	function encode(body: unknown): Uint8Array {
		if (body === undefined) return new Uint8Array();
		if (body instanceof Uint8Array) return body;
		return new TextEncoder().encode(JSON.stringify(body));
	}

	async function request(method: string, path: string, body?: unknown, opts: RequestOpts = {}) {
		const bytes = encode(body);
		const h = await headers(method, path, bytes, opts);
		if (body !== undefined && !(body instanceof Uint8Array)) h["content-type"] = "application/json";
		const init: RequestInit = { method, headers: h };
		if (method !== "GET") init.body = bytes as Uint8Array<ArrayBuffer>;
		return server.app.request(path, init);
	}

	return { sigKey, headers, request, encode };
}

export type TestDevice = Awaited<ReturnType<typeof makeDevice>>;
