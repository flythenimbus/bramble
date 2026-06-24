import { Capacitor, registerPlugin } from "@capacitor/core";
import { PREF_AUTOFILL_QUICKTYPE } from "@core/hooks/usePrefs";
import type { AutofillAdapter } from "@core/index";
import { bytesToBase64 } from "@core/util/bytes";
import { decodeVaultBlob, findPasswordSlot, verifierPrefix } from "@core/vault-format";
import { mobileCrypto } from "./crypto";
import { mobileStorage } from "./storage";

// System autofill on mobile is the native iOS Credential Provider extension, not the
// webview. This adapter is the main-app side of that bridge. To keep Bramble's "nothing
// readable without authenticating" guarantee, the ENTIRE login list (names, usernames,
// passwords) is encrypted under the VEK before it is written to the shared App Group, so
// the extension reveals nothing until the user unlocks it. We also share the password
// SLOT (non-secret vault-header data: salt + verifier + the AES-wrapped VEK) so the
// extension can unlock itself with the master password. No cleartext entry data reaches
// the App Group. The OS QuickType identity store (usernames + domains, no passwords) is
// populated ONLY when the user opts into keyboard suggestions; off by default since those
// identities surface before auth. Android autofill is a separate service (not built yet).

interface SlotPayload {
	saltB64: string;
	slotIdB64: string;
	verifierB64: string;
	wrapIvB64: string;
	wrappedVekB64: string;
	magicVersionB64: string;
}

// A QuickType identity (cleartext): what the OS shows in the keyboard suggestion bar.
// Sent only when the user opts into QuickType; carries no password.
interface QuickTypeIdentity {
	recordId: string;
	username: string;
	service: string;
}

interface AutofillBridgePlugin {
	// `iv`/`ciphertext` are encryptWithVek over the JSON login list (see AutofillEntry).
	// `identities`, when present and non-empty, populate the OS QuickType bar; an empty
	// (or omitted) list clears it.
	sync(o: {
		iv: string;
		ciphertext: string;
		slot?: SlotPayload;
		identities?: QuickTypeIdentity[];
	}): Promise<void>;
	clear(): Promise<void>;
	setKeepUnlocked(o: { minutes: number }): Promise<void>;
}

// Normalize a stored hostname to a bare registrable host for QuickType matching
// (lowercase, drop a leading "www."), mirroring the extension's normalizeHost.
function normalizeHost(h: string): string {
	const s = h.trim().toLowerCase();
	return s.startsWith("www.") ? s.slice(4) : s;
}

const Bridge = registerPlugin<AutofillBridgePlugin>("AutofillBridge");
const isIos = Capacitor.getPlatform() === "ios";

// The primary password slot from the vault header, so the extension can run Argon2id
// and unwrap the VEK from the master password. Non-secret (the wrappedVek stays
// AES-encrypted). Returns undefined for a passwordless vault or an unreadable blob.
async function readPasswordSlot(): Promise<SlotPayload | undefined> {
	try {
		const slot = findPasswordSlot(decodeVaultBlob(await mobileStorage.readVaultBlob()));
		if (!slot) return undefined;
		return {
			saltB64: bytesToBase64(slot.salt),
			slotIdB64: bytesToBase64(slot.slotId),
			verifierB64: bytesToBase64(slot.verifier),
			wrapIvB64: bytesToBase64(slot.wrapIv),
			wrappedVekB64: bytesToBase64(slot.wrappedVek),
			magicVersionB64: bytesToBase64(verifierPrefix()),
		};
	} catch {
		return undefined;
	}
}

export const mobileAutofill: AutofillAdapter = {
	async setIndex(entries) {
		if (!isIos) return;
		const list = [];
		for (const e of entries) {
			if (e.type !== "login" || !e.password) continue;
			list.push({
				recordId: e.id,
				name: e.name,
				username: e.username,
				password: e.password,
				services: e.hostnames,
			});
		}
		// Encrypt the whole list under the VEK. The extension can read no entry data
		// (names, usernames, passwords) until the user authenticates and it can decrypt
		// this. Nothing about the vault is in the App Group in cleartext.
		const enc = await mobileCrypto.encryptWithVek(JSON.stringify(list));
		// QuickType identities (cleartext usernames + domains) are sent ONLY when the user
		// opted in; otherwise the list is empty and the bridge clears the OS store.
		const quickType = (await mobileStorage.getMeta<boolean>(PREF_AUTOFILL_QUICKTYPE)) === true;
		const identities: QuickTypeIdentity[] = quickType
			? list.flatMap((c) =>
					c.username
						? c.services
								.map(normalizeHost)
								.filter((s) => s.length > 0)
								.map((service) => ({ recordId: c.recordId, username: c.username, service }))
						: [],
				)
			: [];
		await Bridge.sync({
			iv: enc.iv,
			ciphertext: enc.ciphertext,
			slot: await readPasswordSlot(),
			identities,
		});
	},
	async clearIndex() {
		// Deliberately a no-op on iOS. The bundle is VEK-encrypted (unreadable at rest)
		// and must survive app lock so the provider can still unlock + fill on its own.
		// setIndex overwrites it when entries change.
	},
	async setKeepUnlocked(minutes) {
		// How long the autofill extension may stay unlocked without re-auth. minutes=0
		// disables it and clears any live session. iOS-only.
		if (!isIos) return;
		await Bridge.setKeepUnlocked({ minutes });
	},
	async query() {
		// The in-webview UI never serves OS autofill; the native provider does.
		return { logins: [], cards: [], otps: [], locked: true, hasPotentialMatch: false };
	},
	async fetchFill() {
		throw new Error("system autofill is handled by the native iOS provider, not the webview");
	},
};
