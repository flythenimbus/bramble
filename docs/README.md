# Bramble design docs

High-level architecture and security design notes for the Bramble password
manager. These docs hold the reasoning that used to live in long code comments:
the "why" behind the crypto, the unlock flows, and the autofill behaviour. Code
comments point here instead of repeating it.

## Index

| Doc | Topic |
|-----|-------|
| [cryptography.md](cryptography.md) | The VEK / slot / KEK wrapping model, key derivation, verifier-based unlock, the password-change vs rotation tradeoff |
| [vek-residency-hardening.md](vek-residency-hardening.md) | Plan: shrink where the in-memory VEK exists outside the Rust core (drop unused returns, MTE, mlock, native-only biometric gate, enrollment last) and why allocator hardening is declined |
| [auth-and-unlock.md](auth-and-unlock.md) | Unlock flows, the slot-policy invariant (always one primary method), verify-without-unlock, error sanitization |
| [security-keys.md](security-keys.md) | WebAuthn PRF / hmac-secret unlock, two-ceremony registration, salt-mismatch retry |
| [totp.md](totp.md) | Stored authenticator keys: accepted input shapes and the "only digits reach the page" model |
| [totp-uri-handler.md](totp-uri-handler.md) | Appearing in iOS's "Set Up Codes In" and Android's chooser by handling inbound `otpauth://` URIs, and why an arriving URI is both untrusted and a secret |
| [recovery-codes.md](recovery-codes.md) | High-entropy offline recovery codes: format, entropy, normalization |
| [vault-format.md](vault-format.md) | The VLT1 v2 on-disk binary layout and TLV slots |
| [password-changelog.md](password-changelog.md) | Superseded passwords kept on a login for propagation lag: the cap, who may write the field, and where it must not leak |
| [autofill.md](autofill.md) | Index, matching, the fetch-on-pick fill model, corner prompt, password generation |
| [field-detection.md](field-detection.md) | Page field detection heuristics and fixtures |
| [field-inventory.md](field-inventory.md) | Plan: collapse the repeated whole-page detector walks into one composed-preorder inventory per parse, without moving any detector result |
| [storage.md](storage.md) | The chrome.storage.local vault backend, crash recovery, legacy FSA migration, durability |
| [encrypted-import.md](encrypted-import.md) | Encrypted imports: the `.bramble` portable vault, KDBX4 internals, Bitwarden encrypted-JSON handling, and the dedup every import shares |
| [credential-exchange.md](credential-exchange.md) | FIDO credential exchange (CXF/CXP) on iOS: the wire format, the OS handoff, and why Android is out |
| [passkey-import.md](passkey-import.md) | Importing passkeys from a file or an OS transfer: what is stored vs what arrives, and every reason one is skipped |
| [lastpass-import.md](lastpass-import.md) | The LastPass CSV export format: two header variants, typed secure notes and their traps, note templates, and the Google signature collision |
| [routing.md](routing.md) | Router guards, back navigation, pop-out handoff |
| [multiple-vaults.md](multiple-vaults.md) | Plan: parallel vaults on one device (local-id registry, one active vault at a time, active-vault-only sync, a primary vault for autofill/biometric) |
| [p2p-sync.md](p2p-sync.md) | Cross-device P2P sync: WebRTC transport, Nostr-subset relay, enrollment + roster-auth, the entry-level merge engine (HLC + tombstones) |
| [p2p-sync-testing.md](p2p-sync-testing.md) | Exercising device sync locally with two browser profiles + the relay |
| [cloud-storage-backups.md](cloud-storage-backups.md) | Planned scheduled encrypted backups: why the provider need not be zero-knowledge, and targeting S3 + WebDAV to cover Nextcloud/self-host and the privacy providers |
| [firefox-port.md](firefox-port.md) | Firefox MV3 port feasibility and the filesystem-sync gap P2P sync fills |
| [mobile-port.md](mobile-port.md) | Capacitor mobile port feasibility; native autofill + biometric-unlock constraints |
| [desktop-port.md](desktop-port.md) | Plan: Tauri 2 desktop app; the spotlight mini app, browser IPC over native messaging, auto-type, SSH agent |
| [macos-credential-provider.md](macos-credential-provider.md) | Plan: an AutoFill credential provider extension in the macOS app, for Safari and native-app fill; what carries over from iOS, and the packaging and App Group unknowns |
| [release-signing.md](release-signing.md) | Chrome Web Store packaging + signing |
| [apt-releases.md](apt-releases.md) | The Debian/Ubuntu channel end to end: R2 behind apt.bramble.sh, the container build, signing the index with a YubiKey-held key, and every failure hit getting there |
| [i18n.md](i18n.md) | Localization across core/iOS/Android/fastlane: Lingui macros, the LLM translation pipeline, commands, and CI/release gates |

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
