import { effectivePartStamps } from "@core/vault/parts";
import { describe, expect, it, vi } from "vitest";
import {
	defaultOffscreen,
	loadBackground,
	type OffscreenResponse,
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

const seed = { wall: 1, counter: 0, node: "seed" };
const SHOWN = {
	id: "login1",
	ciphertext: "c",
	iv: "i",
	wrappedDek: "w",
	dekIv: "d",
	hlc: seed,
	vv: { seed },
};
const other = { wall: 1, counter: 0, node: "other" };
const SIBLING = { ...SHOWN, ciphertext: "s", hlc: other, vv: { other } };
const LOGIN_DATA = {
	type: "login" as const,
	name: "Example",
	urls: ["https://example.com"],
	username: "alice",
	password: "",
};

async function withConflict(decrypted: Record<string, unknown> = LOGIN_DATA) {
	const written: string[] = [];
	const sealed: string[] = [];
	const offscreen = (msg: Record<string, any>): OffscreenResponse => {
		switch (msg.type) {
			case "CRYPTO_DECRYPT_OUTER":
				return {
					ok: true,
					data: JSON.stringify({ entries: [SHOWN], tombstones: [], conflicts: [SIBLING] }),
				};
			case "CRYPTO_DECRYPT":
				return { ok: true, data: JSON.stringify(decrypted) };
			case "CRYPTO_ENCRYPT":
				sealed.push(msg.payload.plaintextJson);
				return { ok: true, data: { ciphertext: "c2", iv: "i2", wrappedDek: "w2", dekIv: "d2" } };
			case "CRYPTO_ENCRYPT_OUTER":
				written.push(msg.payload.plaintext);
				return { ok: true, data: { iv: "oi", ciphertext: "oc" } };
			default:
				return defaultOffscreen(msg);
		}
	};
	await loadBackground({ sessionSeed: { [TEST_VEK_KEY]: "SEED" }, offscreen });
	const { savePlacement } = await import("./passkey-store");
	const last = () => JSON.parse(written[written.length - 1] as string);
	const lastSealed = () => JSON.parse(sealed[sealed.length - 1] as string);
	return { savePlacement, last, lastSealed };
}

describe("savePlacement records history", () => {
	it("a new passkey login gets its own vv under the background's writer key", async () => {
		const { savePlacement, last } = await withConflict();
		await savePlacement({ kind: "create", data: LOGIN_DATA });
		const payload = last();
		const env = payload.entries.find((e: { id: string }) => e.id !== "login1");
		expect(env.hlc.node).toMatch(/#bg$/);
		expect(env.vv).toEqual({ [env.hlc.node]: env.hlc });
		expect(payload.conflicts).toEqual([SIBLING]);
	});

	it("attaching a passkey supersedes the displayed version only", async () => {
		const { savePlacement, last } = await withConflict();
		await savePlacement({
			kind: "attach",
			entryId: "login1",
			passkey: { credentialId: "k" } as never,
		});
		const payload = last();
		const env = payload.entries.find((e: { id: string }) => e.id === "login1");
		expect(env.hlc.node).toMatch(/#bg$/);
		expect(env.vv).toEqual({ seed, [env.hlc.node]: env.hlc });
		expect(payload.conflicts).toEqual([SIBLING]);
	});

	it("attaching a passkey stamps the passkey item at the write's stamp", async () => {
		const { savePlacement, last, lastSealed } = await withConflict();
		const passkey = { credentialId: "cred-1", rpId: "example.com" } as never;
		await savePlacement({ kind: "attach", entryId: "login1", passkey });
		const env = last().entries.find((e: { id: string }) => e.id === "login1");
		const plaintext = lastSealed();
		expect(effectivePartStamps(plaintext, env).items.passkeys).toEqual({ "cred-1": env.hlc });
		expect(effectivePartStamps(plaintext, env).parts.name).toEqual(seed);
		expect(plaintext.partStampsAt).toEqual(env.hlc);
	});

	// The plan is made before the ceremony; a passkey that synced in meanwhile is in the entry the
	// write decrypts, and must stay.
	it("attaching keeps a passkey that synced in after the plan was made", async () => {
		const synced = { credentialId: "synced", rpId: "example.com" };
		const { savePlacement, lastSealed } = await withConflict({ ...LOGIN_DATA, passkeys: [synced] });
		const passkey = { credentialId: "cred-1", rpId: "example.com" } as never;
		await savePlacement({ kind: "attach", entryId: "login1", passkey });
		expect(lastSealed().passkeys.map((p: { credentialId: string }) => p.credentialId)).toEqual([
			"synced",
			"cred-1",
		]);
	});
});
