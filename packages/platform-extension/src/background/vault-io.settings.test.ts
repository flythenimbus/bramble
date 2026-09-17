import { describe, expect, it, vi } from "vitest";
import {
	defaultOffscreen,
	loadBackground,
	type OffscreenResponse,
	pageSender,
	setAutofillIndex,
	TEST_VEK_KEY,
} from "../test/test-harness";

// Same shape as corner-prompt-commit.test.ts: sidestep the binary vault format so the test is
// about the decrypt -> mutate -> re-encrypt glue rather than storage.
vi.mock("../storage", () => ({
	extensionStorage: {
		readVaultBlob: async () => new Uint8Array([1, 2, 3]),
		writeVaultBlob: async () => {},
		getMeta: async () => undefined,
		setMeta: async () => {},
	},
}));

vi.mock("@core/vault-format", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		decodeVaultBlob: () => ({
			slots: [{ kind: 99, payload: new Uint8Array() }],
			entriesIv: new Uint8Array(12),
			entriesCiphertext: new Uint8Array([1]),
		}),
		encodeVaultBlob: () => new Uint8Array([9, 9, 9]),
	};
});

const SETTINGS = {
	"pref.aliasProvider": {
		hlc: { wall: 500, counter: 0, node: "other" },
		value: { provider: "addy" },
	},
};

/**
 * reencryptOuterWithEntryChange rebuilds the payload it writes, so anything it does not carry
 * over is erased. It named `entries` and `tombstones`, which silently dropped the vault's
 * synced settings on every background write: a corner-prompt save or a passkey create wiped
 * them. Invisible locally, because the value is still on screen from memory and only goes
 * missing on reload or when a peer merges the emptied payload back.
 *
 * This asserts on the plaintext actually handed to the outer encrypt, so it cannot pass on
 * in-memory state.
 */
describe("a background entry write preserves the rest of the payload", () => {
	it("keeps synced settings when the corner prompt saves a login", async () => {
		const encrypted: string[] = [];
		const offscreen = (msg: Record<string, any>): OffscreenResponse => {
			switch (msg.type) {
				case "CRYPTO_DECRYPT_OUTER":
					return {
						ok: true,
						data: JSON.stringify({ entries: [], tombstones: [], settings: SETTINGS }),
					};
				case "CRYPTO_ENCRYPT":
					return { ok: true, data: { ciphertext: "c", iv: "i", wrappedDek: "w", dekIv: "d" } };
				case "CRYPTO_ENCRYPT_OUTER":
					encrypted.push(msg.payload.plaintext);
					return { ok: true, data: { iv: "oi", ciphertext: "oc" } };
				default:
					return defaultOffscreen(msg);
			}
		};

		const bg = await loadBackground({ sessionSeed: { [TEST_VEK_KEY]: "SEED" }, offscreen });
		await setAutofillIndex(bg, []);

		const cap = await bg.send(
			{ type: "CORNER_PROMPT_CAPTURE", payload: { username: "bob", password: "secret" } },
			pageSender("newsite.com", 5),
		);
		await bg.send(
			{
				type: "CORNER_PROMPT_RESPONSE",
				payload: { promptId: cap.resp.data.promptId, action: "save" },
			},
			pageSender("newsite.com", 5),
		);

		expect(encrypted).not.toHaveLength(0);
		const written = JSON.parse(encrypted[encrypted.length - 1] as string);
		expect(written.entries).toHaveLength(1); // the save really happened
		expect(written.settings).toEqual(SETTINGS); // and did not cost the settings
	});
});
