# Release signing

Two independent signing setups, both reusing the same age + YubiKey at-rest scheme: the
**extension** (Chrome Web Store verified uploads) below, and the **Android app**
([GitHub-released APK](#android-github-released-apk)) at the end.

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
