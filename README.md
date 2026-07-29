# Bramble

[![Matrix](https://img.shields.io/badge/Matrix-%23general%3Abramble.sh-000000?logo=matrix&logoColor=white)](https://matrix.to/#/%23general:bramble.sh)

A password manager that keeps your secrets on your own devices. No account, no server holding your vault, no company to get breached and leak everything. You hold the vault, you hold the password, and that's it.

Bramble runs where you do:

- **Browser extension** for Chromium browsers (Brave, Vivaldi, Chrome, Arc, and friends). Install it and you're up and running in a minute.
- **iOS app** with system AutoFill, Face ID / Touch ID unlock, and passkeys.
- **Android app** with a native autofill service, biometric unlock, and passkeys.

The same encrypted vault and the same Rust crypto core sit behind all three, and your devices can sync to each other directly, peer-to-peer, with no cloud in the middle.

**Get Bramble:**

- Chromium: [Chrome Web Store](https://chromewebstore.google.com/detail/bramble/kmokhdhoggbdcgoepifeckhgbfakaknm)
- Firefox: [Firefox Add-ons Store](https://addons.mozilla.org/firefox/addon/bramble/)
- Android: [Releases](https://github.com/flythenimbus/bramble/releases)
- iOS: [App Store](https://apps.apple.com/us/app/bramble-password-manager/id6783071787)

## Screenshots

| <img src="docs/screenshots/main.png" width="260" alt="Your vault"><br>**Your vault** | <img src="docs/screenshots/multi-vault.png" width="260" alt="Pick a vault"><br>**Pick a vault** | <img src="docs/screenshots/autofill.png" width="260" alt="Autofill on a page"><br>**Autofill on a page** |
|:--:|:--:|:--:|
| <img src="docs/screenshots/login-new.png" width="260" alt="Save a new login"><br>**Save a new login** | <img src="docs/screenshots/login-update.png" width="260" alt="Update an existing login"><br>**Update an existing login** | <img src="docs/screenshots/login-edit.png" width="260" alt="Editing an entry"><br>**Editing an entry** |
| <img src="docs/screenshots/passkey-save.png" width="260" alt="Create a passkey"><br>**Create a passkey** | <img src="docs/screenshots/passkey-use.png" width="260" alt="Sign in with a passkey"><br>**Sign in with a passkey** | <img src="docs/screenshots/settings-general.png" width="260" alt="Settings"><br>**Settings** |
| <img src="docs/screenshots/settings-security.png" width="260" alt="Unlock methods"><br>**Unlock methods** | <img src="docs/screenshots/settings-backup-pre.png" width="260" alt="Backups and import"><br>**Backups and import** | <img src="docs/screenshots/settings-backup-setup.png" width="260" alt="Scheduled cloud backups"><br>**Scheduled cloud backups** |
| <img src="docs/screenshots/settings-sync.png" width="260" alt="Device sync"><br>**Device sync** |

## What it does

Your passwords are encrypted on your own device and stay there: in the browser's private extension storage on desktop, and in app-private encrypted storage on mobile. There's no server holding your vault and no account to sign up for. To use the same vault on more than one device, Bramble syncs it **directly between your devices, peer-to-peer**, end-to-end encrypted, with no cloud in the middle. Want a copy in your own hands? Export an encrypted backup file any time.

Everything cryptographic happens inside a single Rust core: compiled to WebAssembly in the browser, and to a native library on iOS and Android. Key derivation, encryption, and decryption all run in that core, and derived keys are wiped from memory after use.

## Backups

Nobody else holds a copy of your vault, so keeping a backup is up to you. Bramble gives you two ways to do it:

- **Explicit: export a backup file.** From Settings (browser extension for now), export your whole vault to an encrypted `.bramble` file and stash it somewhere safe: another drive, a USB stick, wherever you like. It stays ciphertext, so opening it still needs your master password and a stolen backup is useless on its own. Do this now and then, especially before any big change.
- **Implicit: peer-to-peer sync.** Turn on sync and every device in your sync group is basically a live copy of the vault. Pair a second device and each one holds everything, so if you lose or wipe one, the others still have your data. It is the simplest safety net there is, with no files to remember to export.
- **Automatic: scheduled cloud backups (browser extension).** Point Bramble at storage you already use and it drops an encrypted backup there on the schedule you pick. Sign in to **Dropbox** in one click, use any **S3-compatible** bucket (Backblaze B2, Cloudflare R2, Storj, Wasabi, MinIO, and friends), or point it at your own **self-hosted WebDAV** server (Nextcloud, ownCloud, Fastmail, and the like). Add as many destinations as you want, each on its own cadence (daily, weekly, or monthly), or press **Back up now** whenever. Only ciphertext ever leaves your device, so the provider stores something it can't read and a stolen backup still needs your master password to open; Bramble keeps the most recent snapshots and prunes the rest. Restoring a backup onto a new or wiped device works from the extension and the mobile apps.

A synced second device and the occasional export together mean you are never one lost or broken device away from losing your vault.

## On your phone

The mobile apps reuse Bramble's Rust crypto core and vault format, with native OS autofill on top:

- **System AutoFill.** Bramble registers as a native OS credential provider, so your logins and one-time codes show up in the keyboard and autofill bar across apps and browsers.
- **Passkeys.** Create and sign in with passkeys, stored as ordinary vault entries so they sync between your devices with everything else.
- **Biometric unlock.** Unlock with Face ID, Touch ID, or Android biometrics gated by the OS keystore, or fall back to your master password or recovery code.
- **On-device storage.** The vault lives on the native filesystem, encrypted at rest, not in a webview database the OS might evict.
- **Peer-to-peer sync.** Pair a phone with your other devices and the vault syncs directly between them, with no relay holding your data.

The iOS and Android apps are versioned and released independently of the extension.

## Features

- **Local-first, always.** Your vault is encrypted and stored on your own device (the browser's private storage on desktop, app-private storage on mobile), never on a server.
- **No shortcuts on crypto.** Argon2id for your key, AES-256-GCM for the data, envelope encryption so every entry has its own key. Secrets get wiped from memory after use.
- **Everything is encrypted.** Site names, usernames, notes, all of it. The only readable part of the stored vault is its header.
- **Smart autofill everywhere.** `www.ikea.com`, `ca.accounts.ikea.com`, and `ikea.com` all match the same login. One entry, several URLs. On the browser it's an on-page dropdown that reaches forms inside iframes and shadow DOM; on mobile it's the OS autofill bar across apps and browsers.
- **Passkeys.** Bramble is your own WebAuthn authenticator: create and sign in with passkeys, in the extension and on both mobile apps. Passkeys are stored as vault entries, so they sync across your devices with no vendor cloud.
- **More than logins.** Logins, payment cards, secure notes, and SSH keys, each with their own fields.
- **Encrypted backups.** Export your whole vault to an encrypted `.bramble` file whenever you want a copy in your own hands. It still needs your master password to open.
- **Export to KeePass.** Save your vault as a standard `.kdbx` (KDBX4) under a password you choose for the file, and open it in KeePassXC or any other KeePass app. No lock-in: the door out is as easy as the door in.
- **Scheduled cloud backups.** Set-and-forget encrypted backups to Dropbox (one-click), any S3-compatible bucket, or self-hosted WebDAV, each on the cadence you choose. Ciphertext only, so the provider can't read a thing (browser extension for now).
- **Built-in password generator.** Strong passwords on tap.
- **Unlock your way.** Master password, a hardware key (YubiKey, Touch ID, Windows Hello via WebAuthn PRF on desktop), biometrics on mobile, or a recovery code. Use them alongside your password, or turn the password off and make one your only way in.
- **Recovery codes.** Every vault gets a high-entropy recovery code at setup: a printable backup that unlocks it independently of your master password. Shown once, stored offline, never kept in plaintext. Reset it any time.
- **TOTP / 2FA codes.** Paste an `otpauth://` URI or bare secret and Bramble generates the six-digit codes.
- **Peer-to-peer sync.** Mirror your vault directly between your own devices over an end-to-end encrypted connection. No cloud, no relay holding your data.
- **Breach checking.** Optional Have I Been Pwned lookup using k-anonymity, so nothing about your password leaves your machine.
- **Auto-lock.** Locks after idle time by default (configurable).
- **Import from the others.** Bring entries over from 1Password, Bitwarden, Proton Pass, KeePass (KDBX4 key files included), Apple Passwords, or Google Password Manager.
- **Multi-key vaults.** LUKS-style key slots, so your master password, a security key, biometrics, or your recovery code can each unlock the same vault.
- **Multiple vaults.** Keep more than one vault side by side and pick which to unlock when you open Bramble. Handy for sharing a device, or walling off separate sets of logins behind their own master passwords.

## Why this beats the cloud managers

The cloud guys keep everyone's vaults on their servers, one giant target. When one gets popped it's not your vault that leaks, it's millions at once, and you find out from a blog post months later. Looking at you, LastPass and Dashlane 👀

Bramble flips that around:

- **No server to breach.** Your vault never leaves your control. No central pile of data for anyone to go after.
- **No account, no subscription, no telemetry.** Nothing to sign up for, nothing phoning home.
- **You own your data.** It lives on your devices, syncs directly between them, and exports to an encrypted file whenever you want an offline copy. Keep it off the internet entirely if you like. Your call.
- **Cloud-like convenience, without the cloud.** Sync keeps every device up to date automatically, like a cloud manager would, but your vault travels straight between them over an end-to-end encrypted link. No central honeypot, no company in the middle.
- **Nothing to trust but the code.** The crypto is open and runs entirely on your device. You're not taking anyone's word that the server "can't read your data."

The tradeoff is real and worth being honest about: there's no "I forgot my password" button on a server somewhere. But you're not without a safety net: every vault gets a recovery code, and you can register a hardware key as another way in. Save the recovery code, keep a second device synced, and export a backup now and then. Lose *all* of your ways in (password, key, and recovery code) and the vault is gone, because nobody else holds a copy.

## How the encryption works

Bramble uses LUKS-style key slots and envelope encryption. There's one random **Vault Key (VEK)** that actually protects your data. Each way of unlocking (master password, security key, biometrics, or recovery code) derives its own **Key-Encryption Key (KEK)** that unwraps a copy of that same Vault Key, so adding or revoking an unlock method never re-encrypts a single entry. The Vault Key then unwraps a fresh per-entry key for every item, and that key decrypts the entry itself. Everything is AES-256-GCM, all of it inside the same Rust core (compiled to WebAssembly in the browser, a native library on mobile).

```mermaid
flowchart TD
    subgraph unlock["Unlock (any one of these)"]
        PW["Master password"]
        SK["Security key<br/>(WebAuthn PRF)"]
        RC["Recovery code"]
    end

    PW -->|"Argon2id"| KEK["Key-Encryption Key (KEK)<br/>32 bytes, never stored"]
    SK -->|"HKDF-SHA256"| KEK
    RC -->|"Argon2id"| KEK

    subgraph slots["Key slots (in the vault)"]
        S["wrapped Vault Key<br/>per slot"]
    end

    KEK -->|"AES-256-GCM unwrap"| VEK["Vault Key (VEK)<br/>random, protects everything"]
    S -.->|"one slot per unlock method"| VEK

    VEK -->|"decrypt entries blob"| ENTRIES["Encrypted entries"]
    VEK -->|"AES-256-GCM unwrap"| DEK["Per-entry key (DEK)<br/>fresh & random per save"]
    DEK -->|"AES-256-GCM decrypt"| DATA["Entry data<br/>(passwords, notes, cards, keys)"]
```

Your master password is only ever used to derive keys inside the crypto core, and the KEK and decrypted keys are wiped from memory after use. In storage, only the vault header is readable; everything else is ciphertext.

## How it stacks up against KeePass

If you love KeePass, you'll feel at home: your encrypted database, your control, no cloud middleman. Bramble even imports your KDBX4 files. Where it's different:

- **🌐 It meets you where you are.** A browser extension and native iOS and Android apps, all on one vault. No separate desktop app or plugin talking to a local program, and no fiddling to get autofill working on your phone.
- **Autofill just works.** Domain matching and an on-page dropdown in the browser, plus system autofill and passkeys on mobile, built in rather than bolted on.
- **One opinionated, modern build** instead of a sprawl of plugins and forks. Argon2id and AES-256-GCM out of the box.
- **Modern UI.** KeePass looks like it escaped from 2003 (no disrespect). Bramble is clean and fast, with dark mode and a layout that won't make you wince.

The KeePass philosophy with a browser-native and mobile-native coat of paint and autofill that works smoothly.

## AI usage disclosure

Parts of Bramble were written with AI assistance (Claude Opus), but every line was directed, reviewed, and shaped by a software engineer with over a decade of experience, the security-critical pieces especially. The AI was a fast typist, not the architect. The codebase is heavily tested, automated and manual, because for security software "it seems to work" isn't good enough.

## What's coming next

- **Cloud backups on mobile.** The browser extension backs up to Dropbox, S3, and WebDAV on a schedule today; bringing those scheduled uploads to the iOS and Android apps is next (mobile can already restore from a backup file).

## Contributing

Open source and contributions welcome. [CONTRIBUTING.md](CONTRIBUTING.md) has the setup steps, the coding standard, and what CI expects. A few things worth knowing up front:

- **Open an issue first for anything big.** Bug reports and small fixes can go straight to a PR. The tracker is at [github.com/flythenimbus/bramble/issues](https://github.com/flythenimbus/bramble/issues).
- **Security software has a higher bar.** Expect changes to come with tests, and the crypto and vault-format paths to get extra scrutiny.
- **Found a security issue?** Please don't file it in the public tracker. Report it privately via [GitHub Security Advisories](https://github.com/flythenimbus/bramble/security/advisories) or email, so it can be fixed before it's out in the open. See [SECURITY.md](SECURITY.md) for details.

PRs that add real-site autofill fixtures or import-format coverage are especially handy.

## Support

Bramble is free and open source. If it's useful to you, a tip is hugely appreciated. 💜 Scan a code with your wallet, or copy an address below.

| Monero (XMR) | Bitcoin · Lightning | Bitcoin · on-chain |
|:---:|:---:|:---:|
| <img src="monero.png" alt="Monero donation QR code" width="200" /> | <img src="bitcoin-lightning.png" alt="Bitcoin Lightning donation QR code" width="200" /> | <img src="bitcoin-onchain.png" alt="Bitcoin on-chain donation QR code" width="200" /> |

**Monero (XMR)**

```
4AC3txuTwFm4fkamoYeK47c9EpnPwbreHNxJeKDYHiDNN6weD5vVA4BCH1azQhSxa6JjereuVpt21Pu2MyRDFDNNH6KGnWq
```

**Bitcoin · Lightning**

```
flythenimbus@cake.cash
```

**Bitcoin · on-chain**

```
bc1q78sd5rnuufqdtv9plp0p56hrq72c9unj8tec8t
```

## License

Bramble is free software, released under the GNU General Public License v3.0. See the [LICENSE](LICENSE) file for the full text. In short: use it, study it, fork it, and share it. If you distribute a modified version, pass the same freedoms along and make your source available under the GPLv3 too.
