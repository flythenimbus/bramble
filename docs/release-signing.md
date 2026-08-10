# Release signing

Four independent signing setups, all reusing the same age + YubiKey at-rest scheme: the
**Chrome extension** (Chrome Web Store verified uploads) below, the **Firefox extension**
([listed on addons.mozilla.org](#firefox-listed-on-addonsmozillaorg)), the **Android app**
([GitHub-released APK](#android-github-released-apk)), and the **desktop app**
([GitHub-released and self-updating](#desktop-app-github-released-and-self-updating)) at the end.

## Chrome Web Store verified uploads

Verified uploads gate who can publish: CWS rejects any package not signed by our
registered RSA key, then repackages it with Google's own key before publishing.
So this key proves "the uploader is us"; it is not the key end users verify.

The signing key is a normal RSA PEM, kept **encrypted at rest** with `age` and
unlocked by a YubiKey (PIN + touch). Because we back up the RSA key itself, a
lost YubiKey does **not** trigger CWS key rotation: we just re-wrap the same key
under a new YubiKey. CWS only stores one public key and rotating it is slow
(support ticket, up to a week), so keeping the RSA key recoverable matters.

## One-time setup

Needs the YubiKey plugged in.

```sh
brew install age age-plugin-yubikey

# 0. Newer YubiKeys (5.7+) ship an AES PIV management key; age-plugin-yubikey
#    needs TDES. Switch it (PIN-protected, leaves existing slot keys intact).
#    Press Enter to use the default current key; enter the PIN when asked.
ykman piv access change-management-key -a TDES --protect

# 1. Create a YubiKey age identity (uses a retired PIV slot, leaves 9a/9c alone).
#    Choose touch policy "always". Note the printed recipient: age1yubikey1...
age-plugin-yubikey --generate

# 2. Generate the RSA signing key (plaintext, temporary).
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out /tmp/cws.pem

# 3. Day-to-day copy: encrypt to the YubiKey recipient.
mkdir -p ~/.config/bramble
age -r age1yubikey1XXXX -o ~/.config/bramble/cws-signing-key.age /tmp/cws.pem

# 4. Recovery copy: passphrase-encrypted, stored OFFLINE (not in the repo, not
#    in CI). Use a long random passphrase kept somewhere separate. This is what
#    saves you if the YubiKey is lost or dies.
age -p -o cws-signing-key.backup.age /tmp/cws.pem

# 5. Public key to register with CWS.
openssl rsa -in /tmp/cws.pem -pubout -out cws-public.pem

# 6. Destroy the plaintext key.
rm -P /tmp/cws.pem
```

Then in the CWS dashboard: **Package -> Verified CRX Uploads -> Opt in**, and
paste `cws-public.pem`. Move `cws-signing-key.backup.age` and the public key to
offline backup; keep nothing plaintext.

## Each release

One command, run from your machine (it will prompt for a YubiKey touch):

```sh
pnpm run release chromium 1.0.0
```

It runs lint + tests, bumps the manifest, builds WASM, bundles, signs
`bramble.crx` locally, tags, pushes, and publishes a GitHub release with the
signed `.crx` (and `.zip`) attached. The signing key never leaves your machine. Publishing fires
`.github/workflows/release.yml`, which only **verifies** the signed `.crx` is
attached; CI never builds or signs.

Then upload the release's `bramble_<platform>_<version>.crx` to the Chrome Web
Store via **Upload New Package**, or the Update API with
`X-Goog-Upload-Protocol: raw` and `X-Goog-Upload-File-Name: <name>.crx`. (The
store upload stays manual, so CWS publish credentials never live in CI either.)

### Building without releasing

`pnpm run bundle` builds and signs locally too (`dist` + `bramble.zip` +
`bramble.crx`), via `sign --optional`: it packs the `.crx` when the key is
present and **skips** (no error) when it is not. To force signing and error if
the key is missing, run `pnpm run sign` on its own. Overrides: pass a dist path as
the first arg to `sign`; set `CWS_KEY_AGE` to point at a different encrypted key.

## If the YubiKey is lost

Decrypt the offline backup and re-wrap under a new YubiKey identity. The RSA key
is unchanged, so the registered public key still matches and no CWS rotation is
needed.

```sh
age -d cws-signing-key.backup.age > /tmp/cws.pem        # passphrase
age-plugin-yubikey --generate                            # new YubiKey recipient
age -r age1yubikey1NEW -o ~/.config/bramble/cws-signing-key.age /tmp/cws.pem
rm -P /tmp/cws.pem
```

## Chrome Web Store — auto-publish (service account)

`pnpm run release chromium <version>` uploads the signed `bramble.crx` to the store and publishes
it (→ CWS review → live), via `scripts/sign-cws.ts` and the Chrome Web Store **REST API v2**
(`chromewebstore.googleapis.com`). Auth is a **Google Cloud service account** (the classic V1
refresh-token flow is deprecated after 15 Oct 2026). The service-account JSON is the secret; it
rides the same age + YubiKey scheme.

The item has **Verified CRX Uploads** enabled, so the store only accepts a signed `.crx` (not a
`.zip`): the upload sends `X-Goog-Upload-File-Name: bramble.crx`, and CWS verifies the `.crx`
signature against the item's registered public key, then repackages under its own key. The `.crx`
must be signed with the key whose public half you registered on the dashboard (Package → Verified
CRX Uploads) — the same `cws-signing-key.age` `pnpm run sign` uses.

### One-time setup

1. [console.cloud.google.com](https://console.cloud.google.com): create/select a project, and in
   the API library enable the **Chrome Web Store API**.
2. **IAM & Admin → Service Accounts → Create** (no roles needed). Open it → **Keys → Add key →
   JSON** and download the key.
3. In the **CWS Developer Dashboard → Account**, add the service-account **email** (only one SA
   per publisher is allowed). The Google account also needs 2-Step Verification on.
4. Encrypt the JSON to the YubiKey and destroy the plaintext:

```sh
age -r age1yubikey1XXXX -o ~/.config/bramble/cws-service-account.age /path/to/downloaded-sa.json
rm -P /path/to/downloaded-sa.json
```

The v2 API is publisher-scoped (`publishers/{id}/items/{id}`), so it also needs your **publisher
id** — the developer-account id shown in the Developer Dashboard URL / Account page. It defaults in
`scripts/sign-cws.ts` (next to `CWS_ITEM_ID`); override with `CWS_PUBLISHER_ID`. The item id also
defaults there; override with `CWS_ITEM_ID`. Creds resolve from `CWS_SERVICE_ACCOUNT_JSON` (a
plaintext path, for CI) else `~/.config/bramble/cws-service-account.age` (override
`CWS_SERVICE_ACCOUNT_AGE`).

### Test / build without publishing

```sh
pnpm run bundle              # build packages/platform-extension/bramble.zip
pnpm run sign:cws --upload-only   # auth + upload only, no publish (safe dry run)
```

### If the service-account key is exposed

Delete the key in Google Cloud (**Service Accounts → Keys**), create a new JSON key, re-encrypt
it (step 4). The service-account email and its CWS access are unchanged, so nothing else to redo.

## Firefox (listed on addons.mozilla.org)

The Firefox add-on ships **listed on addons.mozilla.org** (the public store): we submit the built
extension to AMO on the **listed** channel, a reviewer approves it, and AMO signs + hosts the
`.xpi`. Users install and auto-update from the store; updates are matched by the add-on id
(`firefox@bramble.app`). The GitHub release carries only the **source `.zip` + `SHA256SUMS`** for
transparency, not a signed build. (`--channel unlisted` still signs a self-distributed `.xpi`
locally if ever needed.)

Unlike CWS and Android, **Mozilla holds the signing key**, so there is no local key to protect.
What we protect is the **AMO API secret**, the credential that lets us upload as us. It rides the
same age + YubiKey at-rest scheme. Losing it is low-stakes: AMO API keys can be regenerated at
will (they don't change the signature or the add-on id), so no user-facing rotation is involved.

### One-time setup

Needs the YubiKey plugged in. Reuse your existing `age1yubikey1…` recipient.

```sh
# 1. Create an AMO API credential at
#    https://addons.mozilla.org/developers/addon/api/key/ ("Generate new credentials").
#    You get a JWT issuer (user:XXXXXXXX:XX) and a secret (shown ONCE). Put them in a JSON file.
cat > /tmp/amo.json <<'JSON'
{ "apiKey": "user:XXXXXXXX:XX", "apiSecret": "PASTE_THE_SECRET" }
JSON

# 2. Day-to-day copy: encrypt to the YubiKey recipient (PIN + touch to use).
mkdir -p ~/.config/bramble
age -r age1yubikey1XXXX -o ~/.config/bramble/amo-api-credentials.age /tmp/amo.json

# 3. Destroy the plaintext credentials.
rm -P /tmp/amo.json
```

The add-on id is already set in `packages/manifests/firefox/manifest.json`
(`browser_specific_settings.gecko.id`). Listing copy is localized under
`packages/platform-extension/store/firefox/` and pushed with `pnpm run metadata:firefox`;
screenshots + category are set once in the AMO Developer Hub.

### Each release

```sh
pnpm run release firefox 1.0.0        # prompts for a YubiKey touch to decrypt the AMO secret
```

It runs lint + tests, bumps the firefox `manifest.json` version, builds WASM, bundles
`dist-firefox`, validates it with the addons-linter (the same check AMO runs) **before**
submitting so a validation error fails for free, then **submits it to AMO on the listed channel**
(`web-ext sign --channel listed`, with a source archive attached for review; see
`docs/amo-source-build.md`), tags `1.0.0-firefox`, pushes, and publishes a GitHub release with the
source `bramble_firefox_1.0.0.zip` + `SHA256SUMS`. Nothing is downloaded: AMO signs and publishes
the `.xpi` itself once a reviewer approves it (track it in the Developer Hub). The credentials are
decrypted to a temp file and wiped; they never touch the repo. CI verifies the source `.zip` +
`SHA256SUMS` on the release; it never builds or signs.

**AMO version numbers are unique across channels**, and a listed version must be **higher** than
any previously signed version. If a submission fails after the bump, retry with the next version
(e.g. `1.0.1`). Env overrides: `AMO_API_KEY` / `AMO_API_SECRET` (skip the age file, e.g. in CI),
`AMO_CREDENTIALS_AGE` (encrypted-credentials path).

### Building without releasing

There is no cheap dry run: `web-ext sign` always uploads to AMO and consumes the version. The
release already runs the addons-linter for you before signing, so a validation error stops it for
free; to iterate faster on your own, run `pnpm run bundle:firefox` (build + zip `dist-firefox`, no
signing) and `pnpm run lint:firefox` (the same addons-linter AMO does) directly. Sign only when
actually cutting a release.

### Verifying (what users run)

The `.xpi` on the release is Mozilla-signed, and Firefox refuses to install anything else, so
installation is itself the signature check. For download integrity, match it against the
release's `SHA256SUMS`:

```sh
sha256sum -c SHA256SUMS      # from a dir holding the downloaded .xpi + SHA256SUMS
```

### If the YubiKey is lost

The AMO secret is only a credential, not a signing key, so the simplest fix is to generate a
fresh one at AMO and re-encrypt it. If you kept an offline backup, re-wrap that instead:

```sh
age -d amo-api-credentials.backup.age > /tmp/amo.json    # passphrase (if you made a backup)
age-plugin-yubikey --generate                            # new YubiKey recipient
age -r age1yubikey1NEW -o ~/.config/bramble/amo-api-credentials.age /tmp/amo.json
rm -P /tmp/amo.json
```

## Android (GitHub-released APK)

The Android app is sideloaded from GitHub Releases (no Play Store), so the **APK's own
signature is the end-user trust anchor**: Android pins the signing certificate and rejects any
update not signed by the same key. That key is therefore permanent and **non-rotatable** (a
different key forces users to uninstall, losing their vault), so it is kept **separate from the
CWS key** and backed up well. It reuses the same age + YubiKey at-rest scheme.

### One-time setup

Needs the YubiKey plugged in. Reuse your existing `age1yubikey1…` recipient.

```sh
# 1. Pick the keystore password (PKCS12 uses ONE password for store + key). SAVE it in
#    your password manager now: it is required for every release and cannot be recovered
#    from the keystore. You export it as ANDROID_KEYSTORE_PASSWORD at release time.
export KS_PW="$(openssl rand -base64 24)"; echo "$KS_PW"

# 2. Generate a dedicated release key (RSA 4096, 30-year validity).
keytool -genkeypair -v \
  -keystore /tmp/bramble-release.jks -storetype PKCS12 -alias bramble \
  -keyalg RSA -keysize 4096 -validity 10950 -dname "CN=Bramble" \
  -storepass "$KS_PW" -keypass "$KS_PW"

# 3. Day-to-day copy: encrypt to the YubiKey recipient (PIN + touch to use).
mkdir -p ~/.config/bramble
age -r age1yubikey1XXXX -o ~/.config/bramble/android-release-keystore.age /tmp/bramble-release.jks

# 4. Recovery copy: passphrase-encrypted, stored OFFLINE (not in the repo, not in CI).
age -p -o android-release-keystore.backup.age /tmp/bramble-release.jks

# 5. Record the cert SHA-256 (what users verify); paste it into the "Verifying a release APK"
#    section of packages/platform-mobile/README.md (the single published source of truth).
keytool -list -v -keystore /tmp/bramble-release.jks -alias bramble -storepass "$KS_PW" | grep "SHA256:"

# 6. Destroy the plaintext keystore.
rm -P /tmp/bramble-release.jks
```

Move `android-release-keystore.backup.age` to offline storage (not the repo, not CI).

### Each release

```sh
export ANDROID_KEYSTORE_PASSWORD="…"     # from your password manager
pnpm run release android 1.1.0           # prompts for a YubiKey touch to decrypt the keystore
```

It runs lint + tests, bumps `versionName`, builds the web bundle + Rust FFI, `cap sync`s,
assembles a **signed** release APK (JDK 21), prints the cert SHA-256, tags `1.1.0-android`,
pushes, and publishes a GitHub release with `bramble_android_1.1.0.apk` + `SHA256SUMS`. The
keystore is decrypted to a temp file and wiped; it never touches the repo. `versionCode` is a
build-time timestamp and is left alone. Env overrides: `ANDROID_KEYSTORE_AGE` (encrypted
keystore path), `ANDROID_KEY_ALIAS` (default `bramble`), `ANDROID_KEY_PASSWORD` (defaults to the
store password). CI verifies an APK + matching `SHA256SUMS` are attached; it never builds or signs.

### Verifying (what users run)

The user-facing verification steps and the published certificate fingerprint live in
[`packages/platform-mobile/README.md`](../packages/platform-mobile/README.md) under "Verifying a
release APK", the single published source of truth for the fingerprint.

### If the YubiKey is lost

Same as CWS: decrypt the offline backup and re-wrap under a new YubiKey. The keystore (and thus
the signing cert) is unchanged, so installed apps keep updating normally.

```sh
age -d android-release-keystore.backup.age > /tmp/ks.jks         # passphrase
age-plugin-yubikey --generate                                    # new YubiKey recipient
age -r age1yubikey1NEW -o ~/.config/bramble/android-release-keystore.age /tmp/ks.jks
rm -P /tmp/ks.jks
```

## Desktop app (GitHub-released and self-updating)

Two different signings, and they protect different things.

**Apple Developer ID** makes macOS willing to run the app at all. **The updater key** is what the
installed app checks before applying an update, so it is the one that decides whether a binary
downloaded from the internet gets to replace Bramble on someone's machine. That makes it the most
consequential key in this file: the Chrome and AMO keys prove "the uploader is us" to a store that
re-signs anyway, while this one is verified by end users' own copies.

It is also effectively permanent. Verification uses the public key compiled into the build a user
already has, so rotating the keypair does not roll out — it strands every existing install on a
manual re-download. Treat losing it as unrecoverable-by-design and keep the offline backup.

### Why the key is not ON the YubiKey

Tauri's CLI signs with minisign and takes the key as a path or a string; it cannot drive a hardware
token. So the YubiKey does here what it does for the Android keystore: it gates *access* to a key
that lives encrypted at rest. `scripts/build-desktop.ts` decrypts it (PIN + touch), passes it to
the bundler through the environment, and never writes the plaintext to disk.

`pnpm release desktop <version>` requires notarization credentials as well as the signing key; it
reuses the App Store Connect API key from `fastlane/.env` (see the iOS section). On publish, CI
re-verifies the archive against the public key compiled into the app
(`scripts/verify-updater-signature.mjs`), because an archive signed with the wrong key produces a
release that looks complete and updates nobody.

### One-time setup

Needs the YubiKey plugged in, and assumes you already made an age identity for it in the
[Chrome section](#one-time-setup).

> **`age-plugin-yubikey --identity` needs the slot named.** On 0.5.1 a bare `--identity` prints an
> empty stub and exits 0, so the failure surfaces later as an unexplained `age -d` error.
> `scripts/age-yubikey-identity.ts` discovers serial and slot from `--list`; set
> `AGE_YUBIKEY_SERIAL` / `AGE_YUBIKEY_SLOT` if more than one slot is configured. Decrypting is
> interactive (PIN prompt on the tty, then a touch), so it has to be run from a real terminal.

```sh
# 1. Generate the updater keypair. Choose a password or not; the age wrapper is the real
#    protection, and the build script passes TAURI_SIGNING_PRIVATE_KEY_PASSWORD through if set.
pnpm --filter @vault/platform-desktop exec tauri signer generate -w /tmp/updater.key

# 2. Day-to-day copy, encrypted to the YubiKey.
age -r age1yubikey1XXXX -o ~/.config/bramble/desktop-updater-key.age /tmp/updater.key

# 3. Recovery copy, passphrase-encrypted and stored OFFLINE. Without this, a lost YubiKey means
#    no further updates can ever be signed for anyone already running the app.
age -p -o desktop-updater-key.backup.age /tmp/updater.key

# 4. Destroy the plaintext.
rm -P /tmp/updater.key /tmp/updater.key.pub
```

Put the public half (`/tmp/updater.key.pub`'s contents, printed by step 1) in
`plugins.updater.pubkey` in `packages/platform-desktop/src-tauri/tauri.conf.json`. It is public and
belongs in the repo. Then remove any plaintext `TAURI_SIGNING_PRIVATE_KEY` from `.env.local`, or the
build will keep using it and never ask for the YubiKey.

### Each release

```sh
pnpm build:desktop:universal   # prompts for a touch; aarch64-only via build:desktop
pnpm release:desktop           # writes latest.json from what the build produced
```

Then create the GitHub release tagged `v<version>` and attach the `.dmg`, the `.app.tar.gz` and
`latest.json`. **`latest.json` must be on the LATEST release**: installed apps read that URL, so a
release without it leaves them checking a stale manifest.

The build refuses to run without the key rather than producing an unsigned archive, because an
unsigned one is rejected by every installed app — the release would look complete while updating
silently broke.

### Notarization

Signing alone is not enough: Gatekeeper blocks a signed-but-un-notarized app on any machine that
did not build it. Tauri notarizes during the build when the credentials are present.

Prefer an **App Store Connect API key** over a password: `APPLE_API_ISSUER`, `APPLE_API_KEY` (the
key id) and `APPLE_API_KEY_PATH` (the `.p8`). The `.p8` is a secret and belongs in the same age +
YubiKey scheme as everything else here.

The alternative is `APPLE_ID` + `APPLE_PASSWORD` + `APPLE_TEAM_ID`, where `APPLE_PASSWORD` is an
**app-specific password** from appleid.apple.com → Sign-In and Security → App-Specific Passwords.
Never your Apple ID password: it is not scoped, and revoking it means changing the password you
sign in with everywhere.

### If the YubiKey is lost

Same as the others: decrypt the offline backup and re-wrap under a new identity. The updater key is
unchanged, so the pubkey in the app still matches and users keep updating.

```sh
age -d desktop-updater-key.backup.age > /tmp/updater.key        # passphrase
age-plugin-yubikey --generate                                    # new recipient
age -r age1yubikey1NEW -o ~/.config/bramble/desktop-updater-key.age /tmp/updater.key
rm -P /tmp/updater.key
```
