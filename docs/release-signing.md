# Release signing

Five independent signing setups, all reusing the same age + YubiKey at-rest scheme: the
**Chrome extension** (Chrome Web Store verified uploads) below, the **Firefox extension**
([listed on addons.mozilla.org](#firefox-listed-on-addonsmozillaorg)), the **Android app**
([GitHub-released APK](#android-github-released-apk)), the **iOS app**
([TestFlight and the App Store](#ios-testflight-and-the-app-store)), and the **desktop app**
([GitHub-released and self-updating](#desktop-app-github-released-and-self-updating)) at the end.
The desktop app carries a second, platform-specific signature as well: its Windows installer is
Authenticode-signed through SignPath
([Windows: Authenticode through SignPath](#windows-authenticode-through-signpath)).

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

Every release also needs `gh`, logged in (`gh auth login`), and the tooling below.
`pnpm run release` checks for all of it up front and prints the install command for
your platform, so a missing tool never surfaces after the store publish and the tag.

On Debian/Ubuntu, `age-plugin-yubikey` has no package and builds from source; its
`pcsc-sys` dependency needs the pcsclite headers, and `pcscd` must be running for the
key to enumerate:

```sh
sudo apt install age gh yubikey-manager libpcsclite-dev pkg-config
cargo install age-plugin-yubikey --locked
```

On macOS:

```sh
brew install age age-plugin-yubikey gh ykman
```

Then, on either platform:

```sh
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

```sh
pnpm run release chromium 1.0.0 --ci   # from GitHub: no Mac, no YubiKey, one approval
pnpm run release chromium 1.0.0        # from this Mac: one YubiKey touch for both CWS secrets
```

**From GitHub** (`--ci`), the normal route, through `.github/workflows/chrome-release.yml`. A build
job with no secrets runs the gate, bumps the manifest and bundles; a publish job, approved in the
`chrome-release` environment, packs and signs the `.crx`, submits it to the store and publishes the
GitHub release. It follows the Firefox route:

- **A preflight runs first.** The version must be above the one live on the store, read from the
  update service Chrome itself polls, and the service account must be authorized for this item
  (`sign-cws.ts --check`). Both before anything is packed or committed.
- **The release commit comes before the submission**, which cannot be taken back, while the commit
  can fail if main moved since the build. A failed submission leaves a bump commit and nothing on the
  store, and re-dispatching the same version finishes it.

`crx3` takes its key as a file, so the publish job writes both secrets to 0600 files in a 0700
directory for the seconds packing and submission take, then removes them, as the local route does.
`-f dry_run=true` runs the preflight and packs the `.crx` with the real key, then stops before the
commit:

```sh
gh workflow run chrome-release.yml --ref main -f version=1.0.0 -f dry_run=true
```

**From this Mac**, the fallback: it runs lint + tests, bumps the manifest, builds WASM, bundles,
packs and signs `bramble.crx` locally, uploads it and publishes it to the store with the service
account (below), then tags, pushes, and publishes a GitHub release with the signed `.crx` and `.zip`
attached. Both secrets decrypt on one touch. Publishing fires `.github/workflows/release.yml`, which
verifies the signed `.crx` is attached; the GitHub route, whose own token cannot trigger that
workflow, checks its draft itself before publishing it.

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
pnpm run release firefox 1.0.0 --ci   # from GitHub: no Mac, no YubiKey, one approval
pnpm run release firefox 1.0.0        # from this Mac: a YubiKey touch to decrypt the AMO secret
```

**From GitHub** (`--ci`), the normal route, through `.github/workflows/firefox-release.yml`. A
build job with no secrets runs the gate, bumps the version, bundles and lints; a publish job,
approved in the `firefox-release` environment, submits and publishes. It follows the Android
workflow with two differences, both because Mozilla holds the signing key and what needs guarding is
the version, which an upload consumes for good:

- **A preflight runs first**: the credentials authenticate, they belong to an author of this
  add-on, and the version is above every version AMO already holds. That rules out the one mistake
  that would otherwise leave a release commit for a version AMO refuses.
- **The release commit comes before the upload.** The upload cannot be undone and the commit can
  fail if main moved since the build, so committing first means the failure case is a bump commit
  with nothing uploaded. Re-dispatching the same version finishes it: the manifest already matches,
  so the build changes nothing and the publish job tags that commit and submits again.

`-f dry_run=true` builds, lints, runs the preflight and makes the source archive, then stops. AMO
has no dry run of its own, so this is the only way to test the route without spending a version.

```sh
gh workflow run firefox-release.yml --ref main -f version=1.0.0 -f dry_run=true
```

**From this Mac**, the fallback. It runs lint + tests, bumps the firefox `manifest.json` version, builds WASM, bundles
`dist-firefox`, validates it with the addons-linter (the same check AMO runs) **before**
submitting so a validation error fails for free, then **submits it to AMO on the listed channel**
(`web-ext sign --channel listed`, with a source archive attached for review; see
`docs/amo-source-build.md`), tags `1.0.0-firefox`, pushes, and publishes a GitHub release with the
source `bramble_firefox_1.0.0.zip` + `SHA256SUMS`. Nothing is downloaded: AMO signs and publishes
the `.xpi` itself once a reviewer approves it (track it in the Developer Hub). The credentials are
decrypted to a temp file and wiped; they never touch the repo. On publish, `release.yml` verifies
the source `.zip` + `SHA256SUMS`; the GitHub route checks its own draft instead, since a release made
with the workflow's token fires no other workflow.

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

# 4b. Optional, and the only option off macOS: encrypt the PASSWORD to the same YubiKey, so
#     releases stop needing it in the environment. It decrypts beside the keystore, on the
#     same touch. printf stores the exact bytes; the decrypt strips one trailing newline, so
#     echo works too, but anything past that first newline is kept and will break signing.
printf %s "$KS_PW" | age -r age1yubikey1XXXX -o ~/.config/bramble/android-keystore-password.age

# 5. Record the cert SHA-256 (what users verify); paste it into the "Verifying a release APK"
#    section of packages/platform-mobile/README.md (the single published source of truth).
keytool -list -v -keystore /tmp/bramble-release.jks -alias bramble -storepass "$KS_PW" | grep "SHA256:"

# 6. Destroy the plaintext keystore.
rm -P /tmp/bramble-release.jks
```

Move `android-release-keystore.backup.age` to offline storage (not the repo, not CI).

### Each release

```sh
pnpm run release android 1.1.0 --ci      # from GitHub: no Mac, no YubiKey, one approval
pnpm run release android 1.1.0           # from this Mac: a YubiKey touch to decrypt the keystore
```

**From GitHub** (`--ci`), which is the normal route. It dispatches
`.github/workflows/android-release.yml` and returns. A *build* job with no secrets runs the gate,
bumps the version and builds an unsigned APK; a *publish* job, which waits for your approval in the
`android-release` environment, signs it with the keystore held there, commits the bump through
GitHub's API (so the commit is verified with no key on the runner, and lands only onto the commit
that was built), tags, and publishes. Approve a finished build from a phone and it goes out.

Before anything is public, the signed APK is held to the certificate fingerprint published in
`packages/platform-mobile/README.md`, the same one users are told to check, and a mismatch stops the
release. The draft is then downloaded and checked again before it goes live. `-f dry_run=true` on a
dispatch runs all of that and stops before the commit: the way to test the pipeline or a rotated
secret without spending a version.

```sh
gh workflow run android-release.yml --ref main -f version=1.1.0 -f dry_run=true
```

The keystore and its password reached that environment through `pnpm run ci:secrets`; see
[docs/ci-releases.md](ci-releases.md). The wrappers below remain the recovery path.

**From this Mac**, the fallback when GitHub is the problem. The keystore password resolves in this order: `ANDROID_KEYSTORE_PASSWORD`, then the macOS login
Keychain (`bramble-android-keystore`), then `~/.config/bramble/android-keystore-password.age`
from step 4b. Only the last works off macOS, and it is the one that keeps the password out of
your shell history and environment entirely. The script checks up front that at least one source
exists, so a missing password fails before the build rather than after it.

It runs lint + tests, bumps `versionName` + `versionCode` and commits them, then builds **on this
Mac**: web bundle → Rust FFI for the four ABIs (needs `cargo-ndk` + the NDK) → `cap sync` →
`gradlew assembleRelease` under JDK 21. Gradle has no signing config, so it emits
`app-release-unsigned.apk`; the script then decrypts the keystore to a temp file, signs with
`apksigner` (v2/v3 only — minSdk 24), wipes the key, prints the cert SHA-256, tags `1.1.0-android`,
pushes, and publishes a GitHub release with `bramble_android_1.1.0.apk` + `SHA256SUMS`. The
plaintext keystore exists for the seconds signing takes and never touches the repo or Gradle.

A build failure rewinds the release commit for a clean retry. A *signing* failure (usually a missed
YubiKey touch) keeps the commit and the unsigned APK: re-run with `--resume` to sign that same build
without rebuilding. Env overrides: `ANDROID_KEYSTORE_AGE` (encrypted keystore path),
`ANDROID_KEY_ALIAS` (default `bramble`), `ANDROID_KEY_PASSWORD` (defaults to the store password).
On publish, `release.yml` verifies an APK + matching `SHA256SUMS` are attached. It does not see a
release made from GitHub, whose own token cannot trigger other workflows; that route verifies its
draft itself, more strictly, before publishing.

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

## iOS (TestFlight and the App Store)

Apple holds the signing identity here, unlike everywhere else in this document: the distribution
certificate lives in the login keychain and Xcode renews it, and what a release actually needs from
us is an **App Store Connect API key**, which is what authorizes uploading a build to TestFlight and
editing the listing. So the key is the secret worth protecting, and it rides the same age + YubiKey
scheme as the other four.

One wrapper holds all three parts, because the key id and issuer id are useless apart and this way
nothing about an iOS release sits loose in the repo:

```json
{ "keyId": "...", "issuerId": "...", "key": "-----BEGIN PRIVATE KEY-----\n..." }
```

`scripts/asc-api-key.ts` is the one unlock, shared by the fastlane lanes and by macOS notarization
in `build-macos.ts`, which uses the same Apple key. It prints the JSON on stdout for the Fastfile to
read through backticks rather than fastlane's `sh`, which echoes both what it runs and what it
prints: that output is a private key.

**It was not always wrapped.** Until this change the key sat at `fastlane/AuthKey.p8` as plaintext
PEM, mode 0644, with its ids in `fastlane/.env`. Both were gitignored but neither was encrypted, and
because the container build rsyncs the working tree, every Linux build copied the key into a Docker
volume as well. iOS was the one release path with a bare private key on disk.

### One-time setup

Needs the YubiKey plugged in. Reuse your existing `age1yubikey1…` recipient; encrypting needs
neither PIN nor touch, because a recipient is a public key.

```sh
# 1. Wrap the existing plaintext key (reads fastlane/.env + fastlane/AuthKey.p8).
node scripts/asc-api-key.ts --wrap

# 2. Check it decrypts. Prompts for the PIN, then a touch.
node scripts/asc-api-key.ts | head -c 40

# 3. Only then, remove the plaintext.
rm -P fastlane/AuthKey.p8 fastlane/.env
```

Losing it is low-stakes: App Store Connect keys are revoked and reissued in Users and Access ->
Integrations, and nothing users have installed depends on this key. That is the opposite of the
desktop updater key, and worth remembering before treating them alike.

### Each release

```sh
pnpm run release ios 1.2.0           # builds here: one touch to decrypt the key, then TestFlight
pnpm run release ios 1.2.0 --ci      # builds on a runner instead; see below
```

`fastlane beta` and `fastlane metadata` both go through the same unlock, so each is one touch.
App Store submission stays manual in App Store Connect either way.

### Releasing from a runner

`pnpm run release ios 1.2.0 --ci` bumps, commits, tags and pushes here, then dispatches
`.github/workflows/ios-testflight.yml` with the build number it just committed. The runner builds
and uploads; this machine does not have to be awake for any of it.

**The order flips, and it matters.** A local release uploads first and tags after, so a tag always
names a build TestFlight received. A CI release must push the bump before a runner can build it, so
a failed build leaves a tag naming a build that does not exist. Re-dispatch the same tag once it is
fixed rather than cutting a second version:

```sh
gh workflow run ios-testflight.yml --ref 1.2.0-build214000000-ios -f build=214000000
```

**What approving actually approves.** The job targets the `ios-release` environment, so it parks
until a required reviewer approves it, and environment secrets are injected only afterwards:
nothing is decrypted while it waits. That approval is what replaces the YubiKey touch, and it is a
weaker claim. A touch authorizes specific bytes; an approval authorizes a job whose behaviour is
whatever the workflow file says at the ref being built. Read the ref before approving, and keep
that workflow's actions pinned by commit, which is why it alone in this repo does not use tags.

**Credentials live in two different places on purpose.** The App Store Connect key is a GitHub
environment secret. The signing identity is not: it lives in a private *certificates* repository
managed by fastlane match, and CI is `readonly`, so a runner may use the certificate and profiles
but never create or renew them. Renewal is a local `fastlane certs`, so an expiring profile shows
up as a failed release rather than as a runner minting identities against the team's limited
certificate slots.

**Give CI the weaker key.** The lanes pass `skip_waiting_for_build_processing: true`, which is
exactly the case where a **Developer**-role key can upload a build. Updating build information,
managing testers and pushing metadata need **App Manager**, and those stay here. So generate a
second, Developer-role key for the runner rather than handing it this one.

### One-time setup for CI

1. **A private repository for the identities**, e.g. `bramble-certificates`. Empty, private. It
   holds the distribution certificate and both provisioning profiles, encrypted with a passphrase
   that is not stored in it.

2. **Populate it**, from here, with the YubiKey plugged in. This is the step that mints the
   certificate, so it uses the App Manager key and prompts for a passphrase to encrypt with. That
   passphrase becomes `MATCH_PASSWORD`; it is not recoverable, so put it in the vault.

   ```sh
   MATCH_GIT_URL=git@github.com:<you>/bramble-certificates.git fastlane certs
   ```

   It provisions `app.bramble.mobile` and `app.bramble.mobile.AutoFillProbe` together. The autofill
   extension is signed separately from the app, so a release needs both profiles or App Store
   validation rejects the upload.

3. **A read-only credential for the runner.** A fine-grained personal access token with
   *Contents: Read* on the certificates repository only, base64'd with the username:

   ```sh
   printf '<you>:github_pat_...' | base64 | tr -d '\n'
   ```

4. **The environment.** Repository settings -> Environments -> `ios-release`, add yourself as a
   required reviewer, then add these as *environment* secrets (not repository secrets, so no other
   workflow can read them):

   | Secret | What |
   |---|---|
   | `ASC_KEY_ID` / `ASC_ISSUER_ID` / `ASC_KEY_CONTENT` | The Developer-role key, the .p8 as PEM text |
   | `MATCH_GIT_URL` | `https://github.com/<you>/bramble-certificates.git`, the HTTPS form, since the runner authenticates with a token |
   | `MATCH_PASSWORD` | The passphrase from step 2 |
   | `MATCH_GIT_BASIC_AUTHORIZATION` | The base64 from step 3 |

5. **Check it end to end** before trusting it with a release. `check_only` first, which verifies
   the five secrets, the certificates repo and one live App Store Connect call in a few minutes:

   ```sh
   gh workflow run ios-testflight.yml --ref main -f check_only=true
   ```

   Then the same dispatch without it, which uploads a one-off build and touches no version, no
   commit and no tag.

**The Xcode version is pinned in the workflow, and has to be.** The app calls
AuthenticationServices APIs that exist only in the 26.4 SDK, so an image whose default is older
cannot compile it: the first run of this workflow died on
`ASCredentialExportManager has no member requestExport` twenty minutes in, on macos-15's default
Xcode 16.4. Bump the `xcode` input's default together with the Xcode releases are cut with here,
and keep the runner image new enough to carry it (`macos-26` has 26.0 through 26.6; `macos-15`
stops at 26.3).

### A build that is not a release

Uploading a build without bumping the marketing version is the normal case for testing, and it
works the same way in both places. Build numbers are seconds since 2020, so they always increase
and never collide, and TestFlight happily carries many builds under one marketing version.

- **On a runner:** Actions -> iOS TestFlight -> Run workflow, pick any branch, leave *Build number*
  blank.

  **Mind the train.** App Store Connect closes a marketing version to new builds once it has
  shipped, so a build off a branch still sitting at the released version is rejected on upload
  with `Invalid Pre-Release Train ... is closed for new build submissions`, after the whole build.
  Put an unreleased version in the *Marketing version* input (the next one, say) and the archive
  carries it without the repository changing. Leave it blank only while that version is still open
  on TestFlight.
- **Here:** `pnpm ios:beta`, which is the same lane the release drives, minus the bump and the tag.
  `pnpm ios:ipa` builds the signed IPA to the Desktop and uploads nothing, which needs no key at
  all.

Neither writes to the repository, so a build handed to a tester is not a release and leaves no
trace claiming it was.

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
that lives encrypted at rest. `scripts/build-macos.ts` decrypts it (PIN + touch), passes it to
the bundler through the environment, and never writes the plaintext to disk.

Release notes are drafted from the commit range by the model the i18n scripts already use, then
opened in `$EDITOR` before the release publishes; `--no-edit` skips the editing step. The model is
shown only the `feat`/`fix`/`perf` subjects and told to claim nothing beyond them, and the full
grouped list is kept underneath the summary in a collapsed block, so anything it leaves out is
still one click away. No model reachable, or no terminal, falls back to that list unedited.

`pnpm release desktop <version>` requires notarization credentials as well as the signing key; it
reuses the App Store Connect API key the iOS release uses
([iOS](#ios-testflight-and-the-app-store)). On publish, CI
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
pnpm build:macos       # universal; prompts for a touch. aarch64-only via build:macos:aarch64
pnpm release:desktop   # writes latest.json from what the build produced
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

### Windows: Authenticode through SignPath

The Windows installer is Authenticode-signed by the [SignPath Foundation](https://signpath.org/),
free for open source projects and issuing a real Sectigo certificate. It plays the role the Apple
Developer ID plays above: without it, Windows warns every person who downloads the installer, which
is not a first impression a password manager should make.

What SignPath demands in exchange is **provenance**. Their terms require every job leading up to
the signing request to have run on a GitHub-hosted agent, with the repository, branch and build
agent attested by GitHub itself, so a cross-compiled installer from a maintainer's machine cannot
be signed at all. Windows is therefore the one artifact Bramble ships that is not built locally:
`.github/workflows/sign-windows.yml` builds it on a `windows-latest` runner and submits the single
`*-setup.exe` to SignPath, a maintainer approves the request in the SignPath UI (manual by
design), and the signed installer comes back as the `bramble-windows-signed` artifact. The job
asserts the binary carries a recognizable certificate on the way out, because a silently unsigned
one looks identical until a user hits SmartScreen.

The flow, driven by `scripts/build-windows.ts`:

```sh
pnpm run build:windows --unsigned      # cross-compiled here with cargo-xwin, throwaway updater key:
                                      # for a VM, cannot be signed, must never be released
pnpm run build:windows --ci-start      # dispatch the GitHub build + SignPath signing, record the run
pnpm run build:windows --ci-collect    # wait, download the signed installer, updater-sign it here
```

**Authenticode first, updater signature second.** The `.sig` is generated locally by
`--ci-collect`, over the Authenticode-signed bytes. SignPath signing rewrites the file, so the
reverse order ships a signature over a file that no longer exists and every Windows update fails.
For the same reason the workflow builds with a throwaway key (the bundler refuses to emit updater
artifacts without one) and `--ci-collect` deletes that throwaway `.sig` on arrival: it describes
the pre-signing bytes and no installed app trusts the key that made it.

The updater key never goes to CI at all. SignPath signs for *Windows*; the minisign key signs
for *the updater*, and only the second is the root of trust for updates. Same age + YubiKey scheme
as above, same permanence rules.

One-time setup is in the SignPath dashboard: register the GitHub organization, create a project
pointed at this repository and the `sign-windows.yml` workflow, and pick a signing policy. The
repository then needs `SIGNPATH_API_TOKEN` in **secrets** and `SIGNPATH_ORGANIZATION_ID`,
`SIGNPATH_PROJECT_SLUG` and `SIGNPATH_SIGNING_POLICY_SLUG` in **variables**; the workflow reads
exactly those names. If `gh workflow list` does not show the workflow yet, push `.github/` to the
default branch first: a workflow cannot be dispatched before it exists there.

### If the YubiKey is lost

Same as the others: decrypt the offline backup and re-wrap under a new identity. The updater key is
unchanged, so the pubkey in the app still matches and users keep updating.

```sh
age -d desktop-updater-key.backup.age > /tmp/updater.key        # passphrase
age-plugin-yubikey --generate                                    # new recipient
age -r age1yubikey1NEW -o ~/.config/bramble/desktop-updater-key.age /tmp/updater.key
rm -P /tmp/updater.key
```

## Linux APT repository (`apt.bramble.sh`)

Keys and their rationale here; the end-to-end flow, the runbook and the troubleshooting are in
[apt-releases.md](apt-releases.md).

A fifth signing setup, and the only one whose key can live **on** the YubiKey rather than
encrypted beside it. Debian's tooling signs with GPG, and GPG drives a hardware token natively, so
unlike the updater key (minisign, which Tauri's CLI takes as a path or a string) the private half
never exists off the token at all. That is a strictly better arrangement than everything above,
and it is available here only because of the format.

What the key protects: `apt` trusts a repository because its `Release` file is signed by a key the
user installed into `/usr/share/keyrings`, pinned to that one repository by `Signed-By`. A key
compromise means being able to serve arbitrary packages, installed as root, to everyone who ran
the install snippet. Treat it as the second most consequential key in this file, after the
updater key.

### One-time setup

The OpenPGP applet, which is a different applet from the PIV one `age-plugin-yubikey` uses: the
same token carries both, and setting this up does not disturb the existing age identities.

```sh
# 1. Change both PINs. The factory defaults are 123456 (user) and 12345678 (admin), and a key
#    that can sign a package repository must not be behind a published PIN.
gpg --card-edit
  admin
  passwd          # 1 = PIN, 3 = Admin PIN, then q
  # 2. Ed25519 rather than the RSA-2048 default: smaller, faster on the card, and apt has
  #    understood it for years.
  key-attr        # choose ECC + Curve 25519 for each of the three slots it asks about
  # 3. Generate ON the card. Answer "n" to the off-card backup: not being exportable is the
  #    property being bought here, and this key is replaceable (see below).
  generate
  quit

# 4. Require a physical touch for every signature. Without this the PIN alone signs, and the PIN
#    is cached by gpg-agent, so a compromised machine could sign silently.
ykman openpgp keys set-touch sig on

# 5. The fingerprint goes in .env.local as BRAMBLE_APT_GPG_KEY.
gpg --list-secret-keys --keyid-format=long
```

`publish-apt.ts` exports the public half itself at publish time, so there is no `keys.asc` to
keep in sync by hand.

Two things to check once, because both fail in ways that read as something else:

```sh
# aptly must shell out to gpg. Its own Go OpenPGP implementation cannot talk to a smartcard and
# reports a missing secret key for a key that is plainly there. The script asserts this too.
grep gpgProvider ~/.aptly.conf     # "gpg"

# pinentry has to be able to reach a terminal, or signing hangs with no prompt.
echo test | gpg --clearsign > /dev/null && echo "signing works"
```

Publish `keys.asc` at the repository root. It is public; the point is that it is fetched over
HTTPS from a host we control and then pinned, so a later compromise of the repository host cannot
substitute a different signer.

There is no offline backup of this key, deliberately: an on-card key that cannot be exported is
the property being bought. Losing the token means generating a new key and asking users to install
it once, which is recoverable, unlike an updater-key loss.

### Hosting

Cloudflare R2 (`bramble-apt`) behind the custom domain `apt.bramble.sh`. Not the website's
Cloudflare Pages deployment and not `website/public/`: each release adds a ~10 MB `.deb`, which in
git is permanent, and Pages caps a file at 25 MiB anyway. R2 has no egress fees and the bucket is
S3-compatible, so the release script pushes it with one `rclone sync`.

Two cache rules on that hostname, which matter more than they look:

| Path | Rule | Why |
|---|---|---|
| `/dists/*` | bypass cache | The index. A cached `InRelease` means `apt update` reports no new version, indefinitely |
| `/pool/*` | cache, long TTL | Package filenames carry the version, so they never change |

### Layout

```
keys.asc
bramble.sources
pool/main/b/bramble/bramble_<version>_amd64.deb
dists/stable/main/binary-amd64/Packages{,.gz}
dists/stable/{Release,InRelease}
```

`bramble.sources` is deb822, and the `Signed-By` line is what scopes the key to this repository
rather than trusting it for everything apt fetches:

```
Types: deb
URIs: https://apt.bramble.sh
Suites: stable
Components: main
Architectures: amd64
Signed-By: /usr/share/keyrings/bramble-keyring.asc
```

### Each release

Two steps, split by where the keys are. The Linux artifacts are built in a container, because a
Debian package has to be built on Debian and this machine is a Mac; the signing and publishing run
on the host, because the GPG key is on a YubiKey and Docker Desktop on macOS cannot pass a USB
device through.

```sh
pnpm run build:linux      # container: .deb, .rpm, AppImage -> dist-linux/ (updater key, a touch)
pnpm run publish:apt      # host: aptly add + sign Release (a touch) + rclone sync to R2
```

`build:linux --unsigned` uses a throwaway updater key for iterating; the result installs fine and
can never update, so it is not publishable.

`publish:apt` needs three things in `.env.local`: `BRAMBLE_APT_GPG_KEY` (the fingerprint of the
repository key), and `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` from the R2 API
token. rclone is configured from those variables rather than from an `rclone.conf`, so no
credential is written to disk.

It uploads `pool/` before `dists/`, deliberately: the index names packages by path, and publishing
it first leaves a window where apt is told about a `.deb` that is not there yet. It also exports
`keys.asc` from whatever key actually signed, rather than from a committed copy, because the two
drifting apart produces a repository nobody can verify and an error that reads like a network
fault.

CI only verifies, on release-published: `verify-apt-repository` re-downloads `InRelease` against
the published key with `gpgv`, and then checks that every `Filename:` in `Packages` actually
resolves, which catches a half-finished upload.

### What users run

```sh
curl -fsSL https://apt.bramble.sh/keys.asc | sudo tee /usr/share/keyrings/bramble-keyring.asc > /dev/null
curl -fsSL https://apt.bramble.sh/bramble.sources | sudo tee /etc/apt/sources.list.d/bramble.sources > /dev/null
sudo apt update && sudo apt install bramble
```

### The updater has to stand down

A `.deb` install is updated by `apt`, and Tauri's updater cannot replace a dpkg-managed binary. An
app that keeps offering an update it cannot apply is worse than one that says nothing, so the
in-app updater is disabled whenever the app is not running as an AppImage: the `APPIMAGE`
environment variable is set for AppImage runs and absent otherwise, which is the only reliable
signal available at runtime. See `docs/desktop-port.md`.
