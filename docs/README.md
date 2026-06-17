# Bramble design docs

High-level architecture and security design notes for the Bramble password
manager. These docs hold the reasoning that used to live in long code comments:
the "why" behind the crypto, the unlock flows, and the autofill behaviour. Code
comments point here instead of repeating it.

## Index

| Doc | Topic |
|-----|-------|
| [cryptography.md](cryptography.md) | The VEK / slot / KEK wrapping model, key derivation, verifier-based unlock, the password-change vs rotation tradeoff |
| [auth-and-unlock.md](auth-and-unlock.md) | Unlock flows, the slot-policy invariant (always one primary method), verify-without-unlock, error sanitization |
| [security-keys.md](security-keys.md) | WebAuthn PRF / hmac-secret unlock, two-ceremony registration, salt-mismatch retry |
| [totp.md](totp.md) | Stored authenticator keys: accepted input shapes and the "only digits reach the page" model |
| [recovery-codes.md](recovery-codes.md) | High-entropy offline recovery codes: format, entropy, normalization |
| [vault-format.md](vault-format.md) | The VLT1 v2 on-disk binary layout and TLV slots |
| [autofill.md](autofill.md) | Index, matching, the fetch-on-pick fill model, corner prompt, password generation |
| [field-detection.md](field-detection.md) | Page field detection heuristics and fixtures |
| [storage.md](storage.md) | FSA vs chrome.storage, crash recovery, pending-blob stashing, background writes |
| [kdbx-import.md](kdbx-import.md) | KDBX4 import internals |
| [routing.md](routing.md) | Router guards, back navigation, pop-out handoff |
| [p2p-sync.md](p2p-sync.md) | Cross-device P2P sync: WebRTC transport, Nostr-subset relay, enrollment + roster-auth, the entry-level merge engine (HLC + tombstones) |
| [p2p-sync-testing.md](p2p-sync-testing.md) | Exercising device sync locally with two browser profiles + the relay |
| [firefox-port.md](firefox-port.md) | Firefox MV3 port feasibility and the filesystem-sync gap P2P sync fills |
| [mobile-port.md](mobile-port.md) | Tauri 2 mobile port feasibility; native autofill + biometric-unlock constraints |
| [release-signing.md](release-signing.md) | Chrome Web Store packaging + signing |

## Vocabulary

- **VEK** (Vault Encryption Key): the single random 32-byte key that everything
  in the vault ultimately encrypts under. Generated once at vault creation,
  never derived from a password.
- **KEK** (Key Encryption Key): a per-slot key that wraps a copy of the VEK.
  Derived differently per unlock method (Argon2id from a password, HKDF from a
  security key's secret).
- **DEK** (Data Encryption Key): a per-entry random key that encrypts one
  entry's plaintext. Wrapped under the VEK.
- **Slot**: one unlock method stored in the vault header (password, security
  key, or recovery code). Each slot wraps its own copy of the VEK.
- **Primary unlock method**: a master password or a security key. A recovery
  code is a backup, never a primary.
