# Importing passkeys, and why one gets skipped

Two paths bring passkeys in from a *foreign* format, and both can drop a single credential while
importing everything around it. A dropped passkey is always reported in the preview, never
silent, so a bug report that quotes the warning is usually diagnosable without a device.

- **A file** (Bitwarden JSON today): `core/src/import/bitwarden.ts`.
- **An OS transfer** (FIDO credential exchange, iOS 26+): `core/src/exchange/from-cxf.ts`. See
  [credential-exchange.md](credential-exchange.md).

Both end at the same place: `crypto.passkeyImportPkcs8`, the Rust `passkey_import_pkcs8`, which
parses the PKCS#8 key and rebuilds the COSE public half. That is deliberately the same code
that mints a passkey, so an imported credential cannot drift in shape from a created one.

A `.bramble` portable vault is the exception and skips all of this: its passkeys were minted by
Bramble and are stored in Bramble's own representation, so they are carried verbatim with no
conversion and nothing to drop. Everything below is about the conversion the other two paths
need. See [encrypted-import.md](encrypted-import.md).

## What we store versus what arrives

| | On the wire | In the vault |
|---|---|---|
| Private key | PKCS#8 DER | raw 32-byte P-256 scalar |
| Public key | absent | COSE_Key, re-derived from the scalar |
| `credentialId`, `userHandle` | base64url (CXF) or UUID / `b64.`-prefixed (Bitwarden) | standard base64 |
| `signCount` | whatever the exporter wrote | always 0 |

The scalar-versus-PKCS#8 difference is the one that bites: sending the scalar where PKCS#8 is
expected decodes cleanly everywhere and only fails when something tries to USE the key.

`signCount` is forced to 0 because a counter that goes backwards reads as a cloned
authenticator; CXF requires exporters to zero it, and we do the same for file imports.

## Why a Bitwarden passkey is skipped

Each warning names the login and the passkey's position in it, e.g. `"www.paypal.com" passkey 1`.

| Warning says | Cause | Where |
|---|---|---|
| had an unexpected shape | a field the schema requires is missing or the wrong type | `passkeySchema` |
| uses an unsupported key type, algorithm, or curve | not `public-key` + `ECDSA` + `P-256` | pre-conversion gate |
| has an invalid relying-party ID | fails DNS-label validation, or over 253 chars | `validRpId` |
| has a **credential ID** that is … | see the reasons below | `credentialIdToBase64` |
| has a **user handle** that is … | see the reasons below | `userHandleToBase64` |
| has a **private key** that is … | see the reasons below | `pkcs8ToStandardBase64` |
| has invalid private-key material | the Rust conversion refused it: not a P-256 PKCS#8 key | `passkeyImportPkcs8` |

The three field rejections each carry a reason, so the warning identifies both which field and
what was wrong with it:

| Reason | Means |
|---|---|
| is empty | zero-length after decoding |
| is longer than the N-byte maximum | over the cap; the cap is in the message (credential ID 1023, user handle 1023, private key 1024) |
| is not valid unpadded base64url | contains `=`, `+`, `/`, or another character outside the base64url alphabet |
| is neither a UUID nor a b64.-prefixed value | a `credentialId` in a third form we don't read |

Two warnings are informational and do NOT skip the credential: `had its signature counter reset
to zero`, and `had no valid creation date; a fallback date was used`.

A run where every passkey failed conversion adds one further line pointing at the crypto module
rather than the file. That is nearly always a stale build: the WASM or the uniffi bindings are
older than the Rust. Rebuild with `pnpm core:build` and the platform's `ffi:build:*`.

## Where these limits come from, and which are ours to relax

The caps exist to bound what crosses the bridge, not to enforce the WebAuthn spec on someone
else's data. Bramble stores and replays these bytes; it is not the relying party. So some of
them are stricter than they need to be.

**The user handle cap was relaxed from 64 bytes to 1023**, matching the credential ID. 64 is
WebAuthn's ceiling for `user.id`, and browsers enforce it by throwing a `TypeError` out of
`navigator.credentials.create`. A password manager acting as the authenticator replaces that
call, so the check never runs and a relying party past the ceiling still gets a credential
stored. PayPal is one, and github issue #40 is the report: a Bitwarden export whose PayPal
handle decodes past 64 bytes, skipped on import. Nothing downstream cared. The vault schema
types `userHandle` as a plain string, and the CXF importer never bounded it at all, so the same
credential imported fine over credential exchange and only the Bitwarden path refused it.

The remaining two are still stricter than they need to be, and are worth revisiting when a real
export trips one:

- **Padding refused.** Canonical base64url is unpadded, but an exporter that pads is not
  producing something we cannot read.
- **Empty user handle is fatal.** A non-discoverable credential legitimately has none, and the
  Bitwarden importer deliberately imports `discoverable: false` credentials
  (see below), so this combination is reachable by design.

Changing either changes what is accepted, so it should follow a report naming the field, not
precede one.

## Discoverability

Bitwarden's `discoverable` hint is ignored on import: Bramble has no stored equivalent, so a
credential marked `discoverable: false` is promoted into the discoverable model. It keeps the
same credential ID and key pair, so allow-list sign-in still works, but it may additionally
appear in username-less and conditional pickers.
