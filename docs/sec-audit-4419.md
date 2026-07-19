# Crypto-core security audit (shared Rust core + JS crypto seam)

> Disposable working note. Scope: `packages/core-rust/src/*` (the shared crypto core compiled to
> WASM for the extension and to uniffi for mobile) plus the JS side that drives it
> (`packages/core/src/adapters/crypto*.ts`) and the offscreen dispatcher. Read in full; real data
> flows traced end-to-end. Focus: key derivation, AEAD nonce/tag handling, randomness, signature
> verification, handshake auth, KDBX parsing of untrusted files. Memory-safety findings excluded
> (safe Rust). No code changed.

## Verdict

The crypto core is fundamentally sound. Argon2id/HKDF KDFs are correct, all nonce/salt/key material
comes from a CSPRNG with no reuse, everything authenticates before it is trusted, signature checks
fail closed, and the Noise handshake authenticates peers against the roster. **One concrete
finding** survives scrutiny, and it is a known accepted-risk state (a phase-1 rollout), not a
regression.

---

## Finding 1 - Roster mutation signatures are implemented but not enforced

- **Severity:** MEDIUM
- **Category:** signature_bypass (missing enforcement / fail-open)
- **Confidence:** 7/10 (the code is explicitly a phase-1 tolerant rollout, so this is a documented
  accepted risk - but it is the one real gap between the current build and the intended property).

**Evidence:**

| Location | What it shows |
|----------|---------------|
| `packages/core/src/flags.json:2-3` | `rosterRequireSignatures: false`, `rosterRequireAdmission: false` - enforcement is shipped off. |
| `packages/core/src/sync/roster.ts:180-186` | Verify-if-present: a brand-new id with no `sig` AND no `admission` passes the merge filter unless the (off) `require.*` flags are set. |
| `packages/core/src/sync/roster.ts:169` | Only ids that already carry a `sigKey` are anchored, so a pre-`sigKey` device id is not pinned against a key swap. |
| `packages/core/src/sync/transport/roster-sync.ts:127` | `if (!rosterVerify) return rosterJson;` - the entire verification step no-ops when a host does not wire `roster_verify`, which is an **optional** member of `RosterSyncWasm` (`roster-sync.ts:45`). Fail-open. |

The Rust primitives (`roster_sig.rs`: Ed25519 self-sign over `canonicalRosterEntry`, TOFU key
anchoring, password-derived admission signing) and the TS gate (`verifyRemoteRoster`) implement the
full Item-A design correctly. The gap is purely that enforcement is disabled and the host seam fails
open.

**Exploit scenario:** An attacker who compromises one member device (holding that device's Noise
static key + roster seed, but NOT the master password) pushes a roster over its authenticated KK
channel that contains a new attacker-controlled device entry with no `sig` and no `admission`. Peers
merge it (verify-if-present tolerates it). The rogue device is now a roster member: it completes
Noise KK handshakes and receives sync traffic, and it survives revocation of the originally
compromised device - exactly the rogue-injection / revocation-escape the admission mechanism was
built to close.

**Fix:**

1. Flip `rosterRequireSignatures` and `rosterRequireAdmission` to `true` (phase 2) once the
   migration window for already-enrolled unsigned devices has closed.
2. Make `roster_verify` a **required** member of `RosterSyncWasm` (not optional) so a mis-wired or
   partial host fails closed instead of silently skipping verification (`roster-sync.ts:45,127`).
3. Anchor pre-existing ids too, so a known device can never present a fresh `sigKey` without a valid
   admission signature (`roster.ts:169`).

---

## Areas checked and cleared (no defect)

- **Key derivation (`lib.rs`):** Argon2id `t=3, m=64 MiB, p=1`, 32-byte output; per-slot random
  16-byte salt from `getrandom`; no static salt/pepper/hardcoded key. WebAuthn slots derive the KEK
  via HKDF-SHA256 domain-separated by `titanpass/webauthn/v1` over authenticator entropy. Password
  and WebAuthn KEKs provably cannot collide even on identical input bytes (different algorithms).
- **AEAD nonce uniqueness (`lib.rs`):** every `iv` / `dek_iv` / `wrap_iv` is freshly generated with
  the CSPRNG per operation; entries re-randomize DEK + IV on every save. No counter-derived or
  session-persistent nonce under a fixed key. AES-256-GCM tags are enforced by the `aes-gcm` crate
  (decrypt fails closed); no unauthenticated decryption of secret data.
- **Randomness:** all key/nonce/salt/keypair material comes from `getrandom` / `OsRng` (Rust) and
  `crypto.getRandomValues` (JS). The one `Math.random` in the tree (`platform-extension/src/content/picker.ts:320`)
  only builds a DOM element id, not security material.
- **Signature verification (`roster_sig.rs`, `nostr.rs`, `passkey.rs`):** all length-check inputs and
  return `Ok(false)` / error instead of accept-on-error; no signing/verifying-key confusion; passkey
  assertions bind to the exact `clientDataHash`. `nostr.ts:verifyEvent` recomputes the event id
  before verifying the signature; `mesh.ts:240` drops events that fail verification.
- **Handshake (`handshake.rs`):** Noise_KK pins both static keys (completing the handshake proves
  roster membership); enrollment uses XXpsk3 with a one-time 32-byte PSK, and the joiner pins the
  inviter's static key (`enroll-host.ts:181`). Failed reads drop the session with no retry.
  MITM / downgrade / replay resistance holds.
- **KDBX import (`kdbx.rs`, untrusted input):** bounds-checked cursor (`checked_add` + slice `get`),
  KDF params ceiling-gated before allocation (1 GiB / 64 iters / 64 lanes), cipher + KDF gated by
  UUID allow-list, header SHA + header HMAC verified (`WrongCredential` on mismatch), and each block
  verified by HMAC before its bytes are used. No unauthenticated-then-trusted path. Empty-password
  composite-key handling matches KeePass rules.
- **Per-vault VEK atomicity (`offscreen-core.ts`):** load-then-op runs as one synchronous section
  with no `await` between `unlock_with_vek` and the op, matching the documented atomicity rule that
  fixed the earlier cross-vault key race.

No HIGH findings.
