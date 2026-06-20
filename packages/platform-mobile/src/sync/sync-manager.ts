import type { EntriesPayload, RosterEntry, RosterPayload, SyncEvent } from "@core/index";
import { type EnrollWasm, startEnroll } from "@core/sync/transport/enroll-host";
import type { MeshSession } from "@core/sync/transport/peer-session";
import { mobileStorage } from "../adapters/storage";
import { loadWasm } from "../wasm-loader";

// Mobile sync session manager. The extension runs this in an offscreen document
// driven over chrome.runtime; on mobile the single webview has a DOM, so the same
// transport modules (now in @core/sync/transport) run in-process. WebRTC data
// channels + the WebSocket relay are standard Web APIs available in WKWebView.

interface DeviceKeypair {
	privateKey: string;
	publicKey: string;
}
// The wasm device-keypair export (camelCase result, see #[serde(rename_all)]).
type KeypairWasm = { handshake_generate_keypair(): DeviceKeypair };

const DEVICE_KEYPAIR_KEY = "sync.deviceKeypair";

// This device's Noise static keypair, generated once and persisted. Only the
// PUBLIC key ever leaves the device (it goes in the roster). NOTE: the private key
// sits in Preferences in the clear for the spike; hardening (wrap under VEK /
// Keychain) is the same follow-up as the extension's sync-config.
async function deviceKeypair(): Promise<DeviceKeypair> {
	const stored = await mobileStorage.getMeta<DeviceKeypair>(DEVICE_KEYPAIR_KEY);
	if (stored?.privateKey && stored?.publicKey) return stored;
	const wasm = (await loadWasm()) as unknown as KeypairWasm;
	const kp = wasm.handshake_generate_keypair();
	await mobileStorage.setMeta(DEVICE_KEYPAIR_KEY, kp);
	return kp;
}

const statusSubs = new Set<(s: string) => void>();
const eventSubs = new Set<(e: SyncEvent) => void>();
const report = (s: string) => {
	for (const cb of statusSubs) cb(s);
};
const emit = (e: SyncEvent) => {
	for (const cb of eventSubs) cb(e);
};

export function onSyncStatus(cb: (s: string) => void): () => void {
	statusSubs.add(cb);
	return () => statusSubs.delete(cb);
}
export function onSyncEvent(cb: (e: SyncEvent) => void): () => void {
	eventSubs.add(cb);
	return () => eventSubs.delete(cb);
}

export async function syncDevicePublicKey(): Promise<string> {
	return (await deviceKeypair()).publicKey;
}

let session: MeshSession | null = null;

export async function startEnrollInvite(opts: {
	relayUrl: string;
	groupKeyB64: string;
	psk: string;
	roster: RosterPayload;
	entries: EntriesPayload;
}): Promise<void> {
	const wasm = (await loadWasm()) as unknown as EnrollWasm;
	const { privateKey } = await deviceKeypair();
	session?.stop();
	session = await startEnroll("inviter", {
		relayUrl: opts.relayUrl,
		groupKeyB64: opts.groupKeyB64,
		psk: opts.psk,
		roster: opts.roster,
		entries: opts.entries,
		devicePrivB64: privateKey,
		wasm,
		report,
		onEnrolled: (entryJson) => emit({ kind: "enrolled", entryJson }),
	});
}

export async function startEnrollJoin(opts: {
	relayUrl: string;
	groupKeyB64: string;
	psk: string;
	inviterPub: string;
	ownEntry: RosterEntry;
	password?: string;
	webauthn?: { hmacSecretB64: string; credentialIdB64: string; saltB64: string };
}): Promise<void> {
	const wasm = (await loadWasm()) as unknown as EnrollWasm;
	const { privateKey } = await deviceKeypair();
	session?.stop();
	session = await startEnroll("joiner", {
		relayUrl: opts.relayUrl,
		groupKeyB64: opts.groupKeyB64,
		psk: opts.psk,
		inviterPub: opts.inviterPub,
		ownEntry: opts.ownEntry,
		password: opts.password,
		webauthn: opts.webauthn,
		devicePrivB64: privateKey,
		wasm,
		report,
		onJoined: (r) => emit({ kind: "joined", vaultBlobB64: r.vaultBlobB64, roster: r.roster }),
	});
}

export async function stopSync(): Promise<void> {
	session?.stop();
	session = null;
	report("disconnected");
}
