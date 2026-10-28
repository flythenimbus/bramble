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
| [sync-rebroadcast.md](sync-rebroadcast.md) | Entry sync sends the vault when it changes plus a heartbeat, instead of every 4 s, because over TURN the resend is what would use up the free tier; resend on a failed merge, a 10-minute backstop, and counting the ICE guard's answers |
| [turn-credentials.md](turn-credentials.md) | Rationing the hosted TURN relay: why open-source clients can't be authenticated, the per-requester rate limit, short credentials, the free-tier ceiling and per-credential cap; signed requests and the self-hosted Node relay to come |
| [mailbox-service.md](mailbox-service.md) | Plan: store-and-forward sync for devices that are never online together; a server that holds sealed changes and files only until every device has them, self-hosted or paid for with a Mullvad-style account number, and the payment wall that keeps a card or crypto payment unlinkable to a mailbox |
| [mailbox-service-plan-1-server.md](mailbox-service-plan-1-server.md) | Implementation plan, part 1 of the six-plan mailbox milestone: the signed wire protocol shared from `packages/core`, and the self-hostable server (Hono over Drizzle/SQLite, disk bodies, membership, messages, compaction, blobs and wants, the retention sweep) |
| [mailbox-service-plan-2-client-crypto.md](mailbox-service-plan-2-client-crypto.md) | Implementation plan, part 2 of the mailbox milestone: the mailbox id and seal key derived from the VEK in the Rust core, exposed through wasm, uniffi and Tauri behind `CryptoAdapter`, and the signed message envelope |
| [sync-conflicts.md](sync-conflicts.md) | Plan: stop losing concurrent edits to one entry. Phase A keeps every concurrent version as version-vector siblings and shows the conflict; Phase B merges field groups inside the crypto core, falling back to a Phase A conflict when both sides changed the same group |
| [sync-conflicts-phase-a.md](sync-conflicts-phase-a.md) | Implementation plan for Phase A: causal history primitives, the sibling merge, local and background writes, resolution, the badge and compare view |
| [sync-conflicts-phase-b.md](sync-conflicts-phase-b.md) | Implementation plan for Phase B: part stamps on every writer, the versioned combine function, combining during sync and load behind a flag, edit-form saves that supersede the opened version |
| [p2p-sync-testing.md](p2p-sync-testing.md) | Exercising device sync locally with two browser profiles + the relay |
| [sync-vault-pinning-and-quarantine.md](sync-vault-pinning-and-quarantine.md) | Plan: pin extension sync to one vault, silently quarantine entries a vault can't decrypt, refuse foreign entries at merge, calm unlock errors |
| [file-attachments.md](file-attachments.md) | Plan: files in a vault (entry attachments + standalone Files items); why the bytes cannot ride the entries payload, the immutable content-addressed blob store, per-file FEK + STREAM chunked AEAD, and the WebRTC-only transfer (direct or TURN, never forwarded by the signalling relay) |
| [cloud-storage-backups.md](cloud-storage-backups.md) | Planned scheduled encrypted backups: why the provider need not be zero-knowledge, and targeting S3 + WebDAV to cover Nextcloud/self-host and the privacy providers |
| [synced-settings.md](synced-settings.md) | Plan: a third `PrefScope` (`"synced"`) so a setting crosses devices by one word in the scope table; the stamped map it rides in, why absent must mean "no opinion", and why a locked-readable pref can never be synced |
| [email-aliases.md](email-aliases.md) | Plan: per-site email aliases from Addy.io and SimpleLogin (Fastmail and Forward Email deferred, both paid-only), why plain `fetch` reaches them from every platform while Firefox Relay and DuckDuckGo cannot be, and why an alias suggestion cannot be pre-generated the way a password is , and a catch-all-domain provider that needs no account and makes the address locally |
| [firefox-port.md](firefox-port.md) | Firefox MV3 port feasibility and the filesystem-sync gap P2P sync fills |
| [mobile-port.md](mobile-port.md) | Capacitor mobile port feasibility; native autofill + biometric-unlock constraints |
| [desktop-port.md](desktop-port.md) | Plan: Tauri 2 desktop app; the spotlight mini app, browser IPC over native messaging, auto-type, SSH agent |
| [windows-release-checklist.md](windows-release-checklist.md) | What CI and a scripted install already cover on Windows, and the human checklist for a release: SmartScreen, tray, autostart, browser pairing, updater, both uninstall answers |
| [macos-credential-provider.md](macos-credential-provider.md) | Plan: an AutoFill credential provider extension in the macOS app, for Safari and native-app fill; what carries over from iOS, and the packaging and App Group unknowns |
| [release-signing.md](release-signing.md) | Chrome Web Store packaging + signing |
| [ci-releases.md](ci-releases.md) | Plan: move every build and signature to GitHub Actions, what it costs in trust, and the phases to get there |
| [apt-releases.md](apt-releases.md) | The Debian/Ubuntu channel end to end: R2 behind apt.bramble.sh, the container build, signing the index with a YubiKey-held key, and every failure hit getting there |
| [i18n.md](i18n.md) | Localization across core/iOS/Android/fastlane: Lingui macros, the LLM translation pipeline, commands, and CI/release gates |
| [store-reviews.md](store-reviews.md) | The review ask: the one object holding every threshold, why iOS gets the OS prompt and no card while the browser gets a card and no API, and what to check before shipping a change |

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
