// Device sync: enrollment and the live roster session.
//
// The host runs in THIS webview rather than a separate one. The extension needs an offscreen
// document because MV3's service worker has no DOM; mobile has one webview and so does the
// desktop, so @core's transport, relay client and merge engine run in-process. macOS WKWebView
// exposes RTCPeerConnection, RTCDataChannel and WebSocket, which is what makes that possible
// without a native bridge. See docs/desktop-port.md.
//
// The crypto still comes from the Rust side (`desktopSyncCrypto`), because the VEK lives there
// and never crosses into the webview. That is the only structural difference from mobile.

import type { EntriesPayload, RosterEntry, RosterPayload, WireRecoverySlot } from "@core/index";
import { startEnroll } from "@core/sync/transport/enroll-host";
import type { MeshSession } from "@core/sync/transport/peer-session";
import { desktopCrypto } from "../adapters/crypto";
import { desktopSyncCrypto } from "../sync-crypto";
import { emit, report } from "./bus";
import { clearSyncIdentity, deviceKeypair } from "./keys";
import { clearGroupState, stopRosterSync } from "./roster";

// ---- the enrollment approval ----

let session: MeshSession | null = null;

/**
 * The approval the host is parked on. Held at module scope rather than in a component because
 * the joiner is sitting on an open channel with nothing sent yet, and the window that has to
 * answer can be closed and reopened before it does. Closing the vault window does not end the
 * process here, which makes that more likely, not less.
 */
let pendingApproval: { sas: string; label: string; settle: (ok: boolean) => void } | null = null;

function settleApproval(approved: boolean): void {
	const pending = pendingApproval;
	pendingApproval = null;
	pending?.settle(approved);
}

/** Answer the prompt: true releases the vault to the joiner, false burns the invite. */
export async function approveEnrollment(approved: boolean): Promise<void> {
	settleApproval(approved);
}

/** The prompt still outstanding, for a window that mounted after it was raised. */
export async function getPendingEnrollApproval(): Promise<{ sas: string; label: string } | null> {
	return pendingApproval ? { sas: pendingApproval.sas, label: pendingApproval.label } : null;
}

// ---- enrollment ----

export async function startEnrollInvite(opts: {
	relayUrl: string;
	iceUrl?: string;
	groupKeyB64: string;
	psk: string;
	roster: RosterPayload;
	entries: EntriesPayload;
	passwordCheck?: { saltB64: string; slotIdB64: string; verifierB64: string };
	recoverySlots?: WireRecoverySlot[];
	// NOT accepted, deliberately, and this will have to change. ShellAdapter declares an
	// `admission` field so a host can admission-sign a joiner's entry and write the roster
	// itself; the extension does that because Firefox's event page outlives the popup that
	// would otherwise do it, and a lost write leaves the joiner rejected as "not in roster"
	// when it reconnects. Mobile does not, and leaves it to the UI. Desktop matches mobile for
	// now because the host-side write needs roster storage that arrives with ongoing sync.
	//
	// Desktop has Firefox's hazard though, and worse: the vault window can be closed while this
	// process keeps running, so the UI doing the write is exactly the arrangement that fails.
	// See docs/desktop-port.md.
}): Promise<void> {
	const { privateKey, publicKey } = await deviceKeypair();
	// Captured now, while the user is demonstrably in the vault they are sharing. The VEK is
	// process-global and an invite stays open as long as the code is on screen, so reading it
	// at send time would ship whichever vault they had switched to by then, handing the joiner
	// something it could never open.
	const vekB64 = await desktopCrypto.exportVek();

	session?.stop();
	// A new invite supersedes any prompt left over from the last one.
	settleApproval(false);

	session = await startEnroll("inviter", {
		vekB64,
		devicePubB64: publicKey,
		devicePrivB64: privateKey,
		// Park the transfer on the user's answer: authenticated is not authorized.
		approve: (sas, label) =>
			new Promise<boolean>((resolve) => {
				pendingApproval = { sas, label, settle: resolve };
				emit({ kind: "enroll-approval", sas, label });
			}),
		// The window closed: refuse anything parked on the prompt, and say so rather than
		// leaving a dead prompt on screen.
		onInviteExpired: () => {
			settleApproval(false);
			emit({ kind: "enroll-expired" });
		},
		onEnrollFailed: (message) => emit({ kind: "enroll-failed", message }),
		onEnrollAttemptFailed: (message) => emit({ kind: "enroll-attempt-failed", message }),
		onEnrolled: (entryJson) => emit({ kind: "enrolled", entryJson }),
		relayUrl: opts.relayUrl,
		iceUrl: opts.iceUrl,
		groupKeyB64: opts.groupKeyB64,
		psk: opts.psk,
		roster: opts.roster,
		entries: opts.entries,
		passwordCheck: opts.passwordCheck,
		recoverySlots: opts.recoverySlots,
		wasm: desktopSyncCrypto,
		report,
	});
}

export async function startEnrollJoin(opts: {
	relayUrl: string;
	iceUrl?: string;
	groupKeyB64: string;
	psk: string;
	inviterPub: string;
	ownEntry: RosterEntry;
	password?: string;
	webauthn?: { hmacSecretB64: string; credentialIdB64: string; saltB64: string };
}): Promise<void> {
	const { privateKey } = await deviceKeypair();
	session?.stop();

	session = await startEnroll("joiner", {
		relayUrl: opts.relayUrl,
		iceUrl: opts.iceUrl,
		groupKeyB64: opts.groupKeyB64,
		psk: opts.psk,
		inviterPub: opts.inviterPub,
		ownEntry: opts.ownEntry,
		password: opts.password,
		webauthn: opts.webauthn,
		devicePrivB64: privateKey,
		wasm: desktopSyncCrypto,
		report,
		onSas: (sas) => emit({ kind: "sas", sas }),
		onJoined: (r) => emit({ kind: "joined", vaultBlobB64: r.vaultBlobB64, roster: r.roster }),
		onJoinError: (message) => emit({ kind: "join-error", message }),
	});
}

/**
 * Tear down only the enrollment window, leaving any ongoing sync alone.
 *
 * The pairing code is a bearer credential, so the host must stop listening the moment the
 * dialog closes. But a device adding a third one must not lose its live sync to do it, which
 * is what a full stop would cost.
 */
export async function stopEnrollInvite(): Promise<void> {
	settleApproval(false);
	session?.stop();
	session = null;
	report("invite closed");
}

/** Full teardown: enrollment and the ongoing roster session both. */
export async function stopSync(): Promise<void> {
	settleApproval(false);
	session?.stop();
	session = null;
	stopRosterSync();
	report("disconnected");
}

/**
 * Wipe every trace of sync from this device, for new-vault creation. @core's createVault calls
 * this through the shell.
 *
 * Order matters: stop the mesh before the keys it authenticates with are gone, or the session
 * keeps running against a group this device can no longer prove membership of.
 */
export async function resetSyncState(): Promise<void> {
	await stopSync();
	await clearGroupState();
	await clearSyncIdentity();
}
