// This device's sync identity: the two keypairs that say who it is to the group.
//
// Both live in the OS credential store, not beside the vault, because only their PUBLIC halves
// ever leave the device. The Noise static key authenticates the channel; the Ed25519 seed
// signs roster entries so a peer can tell an admitted device from an injected one. Mobile
// keeps the same two in the Keychain/Keystore for the same reason.
//
// Generated on first use and stable after. Losing either is not fatal to the vault but does
// evict this device from the group, so nothing here regenerates silently on a read failure:
// an error propagates rather than quietly minting a new identity.

import { invoke } from "@tauri-apps/api/core";
import { desktopSyncCrypto } from "../sync-crypto";

/** Namespaced so the credential store can hold unrelated secrets without collision. */
const DEVICE_KEYPAIR_KEY = "sync.deviceKeypair";
const SIGNING_KEY_KEY = "sync.signingKey";

export interface DeviceKeypair {
	privateKey: string;
	publicKey: string;
}

export interface SigningKeypair {
	/** The 32-byte Ed25519 seed. Never leaves the device. */
	secretKey: string;
	publicKey: string;
}

async function secureGet<T>(key: string): Promise<T | null> {
	const raw = await invoke<string | null>("secure_get", { key });
	if (!raw) return null;
	try {
		return JSON.parse(raw) as T;
	} catch {
		// A damaged value is not the same as an absent one, and treating it as absent would
		// mint a new identity and evict this device from its own sync group without saying so.
		throw new Error(`Stored ${key} is unreadable.`);
	}
}

async function secureSet(key: string, value: unknown): Promise<void> {
	await invoke("secure_set", { key, value: JSON.stringify(value) });
}

/** This device's Noise static keypair. Only the public half goes in the roster. */
export async function deviceKeypair(): Promise<DeviceKeypair> {
	const stored = await secureGet<DeviceKeypair>(DEVICE_KEYPAIR_KEY);
	if (stored?.privateKey && stored?.publicKey) return stored;
	const generated = await desktopSyncCrypto.handshake_generate_keypair();
	await secureSet(DEVICE_KEYPAIR_KEY, generated);
	return generated;
}

/** This device's Ed25519 roster-signing keypair. See docs/p2p-sync-revocation-hardening.md. */
export async function signingKeypair(): Promise<SigningKeypair> {
	const stored = await secureGet<SigningKeypair>(SIGNING_KEY_KEY);
	if (stored?.secretKey && stored?.publicKey) return stored;
	const generated = await desktopSyncCrypto.roster_sig_generate_key();
	await secureSet(SIGNING_KEY_KEY, generated);
	return generated;
}

export async function syncDevicePublicKey(): Promise<string> {
	return (await deviceKeypair()).publicKey;
}

export async function syncSigningPublicKey(): Promise<string> {
	return (await signingKeypair()).publicKey;
}

/** Ed25519-sign a canonical roster entry with this device's seed. */
export async function signRoster(canonical: string): Promise<string> {
	const { secretKey } = await signingKeypair();
	return desktopSyncCrypto.roster_sign(secretKey, canonical);
}

/**
 * This device's admission verify key, derived from the master password and this device's
 * password-slot salt. Published in the roster so peers can check which NEW devices this one
 * admits, which is what closes the rogue-injection hole.
 *
 * Derived transiently and never stored: it comes from a freshly typed password every time.
 */
export async function syncAdmissionPublicKey(password: string, saltB64: string): Promise<string> {
	return desktopSyncCrypto.roster_admission_public_key(password, saltB64);
}

export async function syncAdmissionSign(
	password: string,
	saltB64: string,
	canonical: string,
): Promise<string> {
	return desktopSyncCrypto.roster_admission_sign(password, saltB64, canonical);
}

/**
 * Drop this device's sync identity, so a freshly created vault starts un-enrolled.
 *
 * Sync identity belongs to the vault, not the machine: carrying the old keypair into a new
 * vault would leave this device claiming a roster seat in a group it is no longer part of.
 */
export async function resetSyncState(): Promise<void> {
	await invoke("secure_delete", { key: DEVICE_KEYPAIR_KEY });
	await invoke("secure_delete", { key: SIGNING_KEY_KEY });
}
