# Bramble

A password manager that lives in your browser and keeps your secrets on your own machine. No account to sign up for, no server holding your vault, no company that can get breached and leak everything. You hold the file, you hold the password, and that's it.

Bramble is a Chromium extension (Chrome, Edge, Brave, Arc, and friends). Install it from the Chrome Web Store and you're up and running in a minute.

> **Get it from the Chrome Web Store.** (Listing link coming soon.)

## What it actually does

Your passwords get encrypted on your device and written to a single vault file that you choose the location of. Want it in a Dropbox or Google Drive folder so it syncs across your machines? Go for it. Bramble never sees that folder, it just reads and writes one encrypted blob.

Everything cryptographic happens inside a Rust module compiled to WebAssembly. Your master password never touches the JavaScript heap.

## Features

- **Local-first, always.** One encrypted file on disk. You pick where it lives with the native file picker.
- **Real encryption, no shortcuts.** Argon2id to turn your password into a key, AES-256-GCM for the data, envelope encryption so every entry has its own key. Secrets get wiped from memory after use.
- **Everything is encrypted.** Not just passwords. Site names, usernames, notes, all of it. The only readable thing on disk is the file header.
- **Autofill that's smart about domains.** `www.ikea.com`, `ca.accounts.ikea.com`, and `ikea.com` all match the same login. One entry can hold several URLs.
- **More than just logins.** Logins, payment cards, secure notes, and SSH keys, each with their own fields.
- **Built-in password generator.** Strong passwords on tap, right where you need them.
- **Unlock with a hardware key.** Register a YubiKey, Touch ID, or Windows Hello and unlock the vault with a tap instead of typing your passphrase, using the WebAuthn PRF extension (built on the authenticator's `hmac-secret`). The key never hands over its secret, it just helps derive yours. Use it alongside your master password — or turn the master password off entirely and make the key your only way in.
- **Recovery codes.** Every vault gets a high-entropy recovery code at setup — a printable backup that unlocks it independently of your master password. It's shown once, you store it offline, and it's never kept in plaintext. Reset it any time from Settings.
- **TOTP / 2FA codes.** Store your authenticator secrets and Bramble generates the six-digit codes for you. Paste an `otpauth://` URI or a bare secret.
- **Breach checking.** Optional Have I Been Pwned lookup using k-anonymity, so your password (or even its full hash) never leaves your machine.
- **Auto-lock.** Locks itself after 15 minutes of no activity by default (can be configured)
- **Import from KeePass.** Bring your existing KDBX4 database over, key files included.
- **Multi-key vaults.** LUKS-style key slots, so any of your master password, a security key, or your recovery code can unlock the same vault.

## Why this beats the cloud password managers

The cloud guys (you know the ones) keep everyone's vaults on their servers. That's a giant target. When one of them gets popped, it's not your vault that leaks, it's millions of them at once, and you find out from a blog post months later. Looking at you LastPass and Dashlane 👀

Bramble flips that around:

- **There's no server to breach.** Your vault never leaves your control. There's no central pile of encrypted data for anyone to go after. Maximum privacy.
- **No account, no subscription, no telemetry.** Nothing to sign up for and nothing phoning home. You don't pay a monthly fee to read your own passwords.
- **You own the file.** Back it up however you like, sync it however you like, or keep it on one machine and never let it touch the internet.
- **Nothing to trust but the code.** The crypto is open and runs entirely on your device. You're not taking anyone's word that the server "can't read your data." And guess what, the code's is all open source.

The tradeoff is real and worth being honest about: there's no magic "I forgot my password" button on a server somewhere. But you're not without a safety net — every vault gets a recovery code at setup, and you can register a hardware security key as another way in. Save the recovery code somewhere safe and back up your vault file. Lose *all* of them — password, key, and recovery code — and the vault is gone, because nobody else holds a copy.

## How it stacks up against KeePass

If you already love KeePass, you'll feel at home here. Same core idea: your encrypted database, your control, no cloud middleman. Bramble even imports your existing KDBX4 files.

Where it's different:

- **It lives in your browser.** No separate desktop app, no juggling a browser plugin that talks to a local program. Install the extension and you're done.
- **Autofill just works.** Domain matching, a dropdown on the page, the things you'd expect from a modern manager, built in rather than bolted on.
- **One opinionated, modern build** instead of a sprawl of plugins and forks. Argon2id and AES-256-GCM out of the box, no config wizardry required.
- **Modern UI.** Let's be honest, KeePass looks like it escaped from 2003 (no disrespect). Bramble is a clean, fast interface that fits right into your browser, with dark mode and a layout that won't make you wince.

Think of Bramble as the KeePass philosophy with a modern browser-native coat of paint and autofill that works smoothly.

## AI usage disclosure

Parts of Bramble were written with AI assistance (Claude Opus 4.7). That's not the whole story though. Every line was directed, reviewed, and shaped by a software engineer with over a decade of experience, and the security-critical pieces especially got the attention they deserve. The AI was a fast typist, not the architect.

The codebase is heavily tested, through automated and manual testing. Security software is the kind of thing where "it seems to work" isn't good enough, so the goal throughout was explicit, boring, well-covered code over anything clever.

## What's coming next

The local-first foundation is here today. A few things are on the way:

- **Passkey storage.** Bramble will be able to create, store, and serve passkeys for websites, acting as your own WebAuthn authenticator.
- **Smarter autofill.** Ongoing tuning against real-world sites, more form-detection coverage, and fixes for the weird checkout and login pages that like to break things.

Further out for v2: Firefox and Safari, mobile, file attachments on entries, and iframe/shadow-DOM autofill.

## Status

Early days, but the core is real and working. v1 targets Chromium browsers (MV3). Firefox is on the roadmap.

If you find a bug or have an idea, open an issue.

## Contributing

Bramble is open source and contributions are welcome. A few things worth knowing before you dive in:

- **Open an issue first for anything big.** Bug reports and small fixes can go straight to a PR.
- **Security software has a higher bar.** Expect changes to come with tests, and expect the crypto and vault-format paths to get extra scrutiny.
- **Found a security issue?** Please don't file it in the public tracker. Report it privately so it can be fixed before it's out in the open. (Email: flythenimbus@pm.me)

If you're just here to poke at the code, clone it, run the tests, and have a look around. PRs that add real-site autofill fixtures or import-format coverage are especially handy.

## Support

Bramble is free and open source. If it's useful to you, toss some Monero our way.

<p align="center">
  <img src="monero.png" alt="Monero donation QR code" width="200" />
</p>

```
4AC3txuTwFm4fkamoYeK47c9EpnPwbreHNxJeKDYHiDNN6weD5vVA4BCH1azQhSxa6JjereuVpt21Pu2MyRDFDNNH6KGnWq
```

## License

Bramble is free software, released under the GNU General Public License v3.0. See the [LICENSE](LICENSE) file for the full text. In short: use it, study it, fork it, and share it. If you distribute a modified version, you have to pass the same freedoms along and make your source available under the GPLv3 too.
