# Recovery codes

A recovery code is a high-entropy passphrase the user saves offline as a
last-resort unlock, for the disaster case of a lost master password and lost
security keys. Code: `packages/core/src/vault/recovery-code.ts`, with the slot
mechanics in `slot-policy.ts` and `vault-format.ts`.

## A backup, never a primary method

Cryptographically a recovery code is a password slot: its KEK is an Argon2id
derivation of the code, and its on-disk payload is byte-identical to a password
slot. Only the slot **kind** byte differs (`0x03` recovery vs `0x01` password).

That separate kind is the whole point. It keeps the recovery code out of the
master-password unlock path (the password unlock never silently tries the
recovery slot), and it lets the UI treat the code as a backup rather than a
primary unlock method. Per invariant B (see
[auth-and-unlock.md](auth-and-unlock.md)) a recovery code never satisfies the
"always one primary method" guard.

A vault holds at most one recovery code. "Reset recovery code" replaces the
existing slot atomically (`upsertRecoverySlot`). Generating one requires the
vault to be unlocked, since it wraps the live in-memory VEK.

## Format and entropy

The displayed code is six groups of five characters,
`XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX`. That is 30 characters times 5 bits, so
**150 bits of entropy**.

The alphabet is **Crockford base32** (`0123456789ABCDEFGHJKMNPQRSTVWXYZ`, no
I/L/O/U), chosen so the code is unambiguous to read and type. Each random byte is
masked to its low 5 bits (`& 0x1f`), which spans exactly `[0, 32)`, so indexing
the 32-character alphabet is uniform with no modulo bias.

## Normalization (typing it back)

The string shown to the user (with dashes) is for display. The secret actually
fed to the KDF is `normalizeRecoveryCode(displayed)`. **Every call site that
wraps or unwraps with a code must normalize first.**

Normalization uppercases, strips anything outside `[0-9A-Z]` (so dashes and
whitespace go), and folds the characters Crockford treats as interchangeable
(`O` to `0`, `I`/`L` to `1`). The result: a code typed back with different
casing, spacing, or visually-similar characters still matches.

## UI placement

In the unlock screen the recovery code is a collapsible secondary form, never the
primary (password or security key is primary). After unlocking with it, the user
is told to generate a fresh one in Settings, since it is purely for disaster
recovery.
