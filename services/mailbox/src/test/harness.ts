// Test-only: an in-memory server with a fake clock, and devices that sign requests the way the
// apps will (an Ed25519 roster key over canonicalRequest).

import { randomBytes, type webcrypto } from "node:crypto";
import {
	canonicalRequest,
	HEADERS,
	InboxResponseSchema,
	MembersResponseSchema,
	sha256Hex,
} from "@vault/core/src/sync/mailbox/protocol.ts";
import { expect } from "vitest";
import { type AppDeps, createApp } from "../core/app.ts";
import { type BodyStore, HashMismatchError } from "../core/bodies.ts";
import { openDb } from "../node/db.ts";

async function collect(body: ReadableStream<Uint8Array> | Uint8Array): Promise<Uint8Array> {
	if (body instanceof Uint8Array) return body;
	return new Uint8Array(await new Response(body).arrayBuffer());
}

/** `now` stamps modifiedAt; the harness passes its fake clock so orphan ages line up with the server's. */
export function memoryBodies(now: () => number = Date.now): BodyStore {
	const store = new Map<string, { bytes: Uint8Array; modifiedAt: number }>();
	return {
		async put(key, body, opts) {
			const bytes = await collect(body);
			if (opts?.sha256 && (await sha256Hex(bytes)) !== opts.sha256) throw new HashMismatchError();
			store.set(key, { bytes, modifiedAt: now() });
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
		bodies: memoryBodies(() => clock.now),
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
	/** Applied last, over the signed headers. */
	headers?: Record<string, string>;
	/** Sent instead of the signed body, to test a body that does not match its hash. */
	sendBytes?: Uint8Array;
}

const b64 = (bytes: ArrayBuffer | Uint8Array) =>
	Buffer.from(bytes as ArrayBuffer).toString("base64");

type Send = (path: string, init: RequestInit) => Response | Promise<Response>;

/** A device with its own Ed25519 key, signing with `now` and sending through `send`. */
async function deviceWith(now: () => number, send: Send) {
	const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
		"sign",
		"verify",
	])) as unknown as webcrypto.CryptoKeyPair;
	const sigKey = b64(await crypto.subtle.exportKey("raw", pair.publicKey));

	async function headers(method: string, path: string, bytes: Uint8Array, opts: RequestOpts = {}) {
		const time = opts.time ?? now();
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
		const sent = opts.sendBytes ?? bytes;
		// fetch sends a length for a known-size body; app.request does not, so set it as fetch would.
		if (body instanceof Uint8Array) h["content-length"] = String(sent.length);
		const init: RequestInit = { method, headers: { ...h, ...opts.headers } };
		if (method !== "GET") init.body = sent as Uint8Array<ArrayBuffer>;
		return send(path, init);
	}

	return { sigKey, headers, request, encode };
}

/** Against the in-memory server, on its fake clock. */
export const makeDevice = (server: TestServer) =>
	deviceWith(
		() => server.clock.now,
		(path, init) => server.app.request(path, init),
	);

/** Against a real port, on the real clock. `baseUrl` may be a getter, so one key can follow a
 * restarted server to its new port. fetch sets content-length itself. */
export const makeRemoteDevice = (baseUrl: string | (() => string)) =>
	deviceWith(Date.now, (path, init) => {
		const { "content-length": _, ...headers } = init.headers as Record<string, string>;
		const base = typeof baseUrl === "string" ? baseUrl : baseUrl();
		return fetch(base + path, { ...init, headers });
	});

export type TestDevice = Awaited<ReturnType<typeof makeDevice>>;

export const newMailboxId = () => randomBytes(32).toString("base64url");

/** A server and `n` devices, each with its own key. */
export async function setup(n: number, opts: ServerOpts = {}) {
	const server = makeServer(opts);
	const devices = await Promise.all(Array.from({ length: n }, () => makeDevice(server)));
	return { server, devices };
}

/** `owner` creates a mailbox listing itself (active) and `others` (eligible). */
export async function createMailbox(
	owner: TestDevice,
	others: TestDevice[] = [],
	id = newMailboxId(),
) {
	const res = await owner.request("POST", `/v1/mailboxes/${id}`, {
		members: [owner.sigKey, ...others.map((d) => d.sigKey)],
	});
	expect(res.status).toBe(200);
	return id;
}

/** `others` activate themselves in `id`. */
export async function activate(id: string, ...others: TestDevice[]) {
	for (const d of others) {
		expect(
			(await d.request("POST", `/v1/mailboxes/${id}/activation`, { active: true })).status,
		).toBe(200);
	}
}

/** Each member's status, keyed by sigKey, as `device` sees it. */
export async function memberStatuses(device: TestDevice, id: string) {
	const res = await device.request("GET", `/v1/mailboxes/${id}/members`);
	expect(res.status).toBe(200);
	const { members } = MembersResponseSchema.parse(await res.json());
	return Object.fromEntries(members.map((m) => [m.sigKey, m.status]));
}

export const newMessageId = () => randomBytes(16).toString("base64url");

/** `from` posts `bytes` (default: 8 random bytes) to mailbox `id`. */
export async function postMessage(
	from: TestDevice,
	id: string,
	opts: { msgId?: string; bytes?: Uint8Array; to?: TestDevice[]; replaces?: string[] } = {},
) {
	const msgId = opts.msgId ?? newMessageId();
	const bytes = opts.bytes ?? randomBytes(8);
	const body: Record<string, unknown> = { id: msgId, body: Buffer.from(bytes).toString("base64") };
	if (opts.to) body.to = opts.to.map((d) => d.sigKey);
	if (opts.replaces) body.replaces = opts.replaces;
	const res = await from.request("POST", `/v1/mailboxes/${id}/messages`, body);
	return { res, msgId };
}

export async function inbox(device: TestDevice, id: string) {
	const res = await device.request("GET", `/v1/mailboxes/${id}/inbox`);
	expect(res.status).toBe(200);
	return InboxResponseSchema.parse(await res.json());
}

export const inboxIds = async (device: TestDevice, id: string) =>
	(await inbox(device, id)).messages.map((m) => m.id).sort();

export async function ack(
	device: TestDevice,
	id: string,
	body: { messages?: string[]; blobs?: string[]; markers?: number[] },
) {
	const res = await device.request("POST", `/v1/mailboxes/${id}/acks`, body);
	expect(res.status).toBe(204);
}

/** `from` uploads `bytes` as a blob, addressed by their SHA-256. */
export async function uploadBlob(
	from: TestDevice,
	id: string,
	bytes: Uint8Array,
	opts: RequestOpts = {},
) {
	const hash = await sha256Hex(bytes);
	const res = await from.request("PUT", `/v1/mailboxes/${id}/blobs/${hash}`, bytes, opts);
	return { res, hash };
}
