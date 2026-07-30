// CXF 1.0 (FIDO Proposed Standard, 2025-08-14) as it appears on the wire.
//
// The key names here are the JSON ones, which are NOT Apple's Swift property names:
// `ASImportableAccount.userName` encodes as `username`, `created` as `creationAt`,
// `credentialID` as `credentialId`. Confirmed by encoding a payload against the real
// framework; see scripts/cxf-wire-probe.swift and docs/credential-exchange.md.
//
// Deliberately lenient. This parses another vendor's export, so anything CXF marks
// required that we can recover from is optional here, and objects stay loose so a
// field we don't model can't fail the parse. The strict shape is whatever `to-cxf.ts`
// emits, pinned by its tests rather than by this schema.

import { z } from "zod";

/** CXF EditableField types. Unknown values degrade to "string" rather than failing the item. */
const cxfFieldTypeSchema = z.enum([
	"string",
	"concealed-string",
	"email",
	"number",
	"boolean",
	"date",
	"year-month",
	"wifi-network-security-type",
	"country-code",
	"subdivision-code",
]);

const cxfEditableFieldSchema = z.looseObject({
	id: z.string().optional(),
	fieldType: cxfFieldTypeSchema.catch("string").optional(),
	value: z.string().optional(),
	label: z.string().optional(),
});

const basicAuthSchema = z.looseObject({
	type: z.literal("basic-auth"),
	username: cxfEditableFieldSchema.optional(),
	password: cxfEditableFieldSchema.optional(),
});

// `secret` is base32 TEXT on the wire. Apple's Swift type takes raw Data and base32-encodes
// it for you, so anything routed through ASImportableCredential.TOTP must not be pre-encoded.
const totpSchema = z.looseObject({
	type: z.literal("totp"),
	secret: z.string(),
	period: z.number().optional(),
	digits: z.number().optional(),
	username: z.string().optional(),
	algorithm: z.enum(["sha1", "sha256", "sha512"]).catch("sha1").optional(),
	issuer: z.string().optional(),
});

// `key` is the PKCS#8 private key, base64url unpadded. CXF carries no public key and no
// COSE algorithm; the algorithm is implied by the key itself.
const passkeySchema = z.looseObject({
	type: z.literal("passkey"),
	credentialId: z.string(),
	rpId: z.string(),
	username: z.string().optional(),
	userDisplayName: z.string().optional(),
	userHandle: z.string(),
	key: z.string(),
});

const noteSchema = z.looseObject({
	type: z.literal("note"),
	content: cxfEditableFieldSchema.optional(),
});

const creditCardSchema = z.looseObject({
	type: z.literal("credit-card"),
	number: cxfEditableFieldSchema.optional(),
	fullName: cxfEditableFieldSchema.optional(),
	cardType: cxfEditableFieldSchema.optional(),
	verificationNumber: cxfEditableFieldSchema.optional(),
	pin: cxfEditableFieldSchema.optional(),
	expiryDate: cxfEditableFieldSchema.optional(),
	validFrom: cxfEditableFieldSchema.optional(),
});

const sshKeySchema = z.looseObject({
	type: z.literal("ssh-key"),
	keyType: z.string().optional(),
	privateKey: z.string(),
	keyComment: z.string().optional(),
});

const customFieldsSchema = z.looseObject({
	type: z.literal("custom-fields"),
	id: z.string().optional(),
	label: z.string().optional(),
	fields: z.array(cxfEditableFieldSchema).optional(),
});

/** The credential types we map. Also the emit-side type: `to-cxf.ts` produces only these. */
export const cxfCredentialSchema = z.discriminatedUnion("type", [
	basicAuthSchema,
	totpSchema,
	passkeySchema,
	noteSchema,
	creditCardSchema,
	sshKeySchema,
	customFieldsSchema,
]);

/**
 * Anything else: a CXF type we don't model (passport, wifi, address, ...), or one we do
 * model that arrived malformed. Both are salvaged as custom fields rather than dropped,
 * so this is kept out of the union above to keep `type` narrowing honest.
 */
export const cxfUnknownCredentialSchema = z.looseObject({ type: z.string() });

const cxfScopeSchema = z.looseObject({
	urls: z.array(z.string()).optional(),
	androidApps: z.array(z.unknown()).optional(),
});

const cxfItemSchema = z.looseObject({
	id: z.string().optional(),
	creationAt: z.number().optional(),
	modifiedAt: z.number().optional(),
	title: z.string().optional(),
	subtitle: z.string().optional(),
	favorite: z.boolean().optional(),
	scope: cxfScopeSchema.optional(),
	// Left unknown so one unparseable credential can't fail the whole item; from-cxf.ts
	// classifies each against the union above and salvages the rest.
	credentials: z.array(z.unknown()).optional(),
	tags: z.array(z.string()).optional(),
});

const cxfAccountSchema = z.looseObject({
	id: z.string().optional(),
	username: z.string().optional(),
	email: z.string().optional(),
	fullName: z.string().optional(),
	collections: z.array(z.unknown()).optional(),
	items: z.array(cxfItemSchema).optional(),
});

/** Version is an object on the wire, not the string "1.0". */
const cxfVersionSchema = z.looseObject({
	major: z.number().optional(),
	minor: z.number().optional(),
});

export const cxfPayloadSchema = z.looseObject({
	version: cxfVersionSchema.optional(),
	exporterRpId: z.string().optional(),
	exporterDisplayName: z.string().optional(),
	timestamp: z.number().optional(),
	accounts: z.array(cxfAccountSchema).optional(),
});

export type CxfEditableField = z.infer<typeof cxfEditableFieldSchema>;
export type CxfCredential = z.infer<typeof cxfCredentialSchema>;
export type CxfItem = z.infer<typeof cxfItemSchema>;
export type CxfPayload = z.infer<typeof cxfPayloadSchema>;

/** The CXF version we emit and the only one Apple negotiates today. */
export const CXF_VERSION = { major: 1, minor: 0 } as const;
