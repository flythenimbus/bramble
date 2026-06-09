# Vault format (VLT1 v2)

The on-disk binary layout of a vault. Code:
`packages/core/src/vault-format.ts`. The crypto that fills these fields is in
[cryptography.md](cryptography.md).

## On-disk layout

```
  0       4   Magic "VLT1"
  4       1   Version (0x02)
  5       1   slotCount (uint8, max 16)
  6       …   slots[] (each slot is TLV):
                1 byte  kind  (0x01 password, 0x02 webauthn, 0x03 recovery)
                2 bytes len   (big-endian)
                N bytes payload
  …      12   entriesIv
  …       N   entriesCiphertext  (AES-256-GCM under VEK)
```

Slots wrap copies of a single random VEK. Entry DEKs and the outer entries blob
are encrypted under the VEK, so adding, revoking, or rotating a slot never
touches per-entry ciphertext.

## Slots are TLV

Each slot is a type-length-value record: a 1-byte kind, a 2-byte big-endian
length, then the payload. There are at most 16 slots (`MAX_SLOTS`).

Three kinds are understood:

- **Password** (`0x01`): fixed-length payload of
  `slotId(16) | salt(16) | verifier(32) | wrapIv(12) | wrappedVek(48)`. The salt
  is the Argon2id salt; the wrapped VEK is 32 bytes plus a 16-byte GCM tag.
- **WebAuthn** (`0x02`): variable-length, because the credentialId varies per
  authenticator. Layout is
  `slotId(16) | credentialIdLen(u16-BE) | credentialId | salt(32) | verifier(32) | wrapIv(12) | wrappedVek(48)`.
  The salt here is 32 bytes (the CTAP2 hmac-secret salt requirement). The
  credentialId is not secret; it drives `allowCredentials` on the unlock prompt.
- **Recovery** (`0x03`): byte-identical to the password payload. The codec is
  shared (`encodeRecoveryPayload` just delegates with the kind swapped); only the
  kind byte differs so the two never collapse into one slot type. See
  [recovery-codes.md](recovery-codes.md).

## Forward compatibility

Unknown slot kinds are preserved verbatim as an `OpaqueSlot` (kind + raw
payload). A build that does not understand a slot kind still round-trips a blob
containing it without losing data, so a newer build can add slot kinds and an
older build can read and re-emit those blobs.

## Verifier prefix

`verifierPrefix()` returns `MAGIC || VERSION` (`"VLT1" || 0x02`). This is the
`magic_version` passed to the WASM wrap / unwrap / verify functions, binding a
verifier to a specific format version. It is exported so callers do not
reconstruct it by hand.

## Decoder safety

`decodeVaultBlob` bounds-checks every read: it rejects a short header, wrong
magic, an unsupported version, a zero or over-limit slot count, and any slot or
trailing IV that overruns the blob. Each failure is a specific thrown error.
Those raw errors are not shown to users directly; the unlock layer wraps them in
a friendly message (see [auth-and-unlock.md](auth-and-unlock.md)).
