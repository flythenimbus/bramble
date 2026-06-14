# Release signing (Chrome Web Store verified uploads)

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
bun run release chromium 1.0.0
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

`bun run bundle` builds and signs locally too (`dist` + `bramble.zip` +
`bramble.crx`), via `sign --optional`: it packs the `.crx` when the key is
present and **skips** (no error) when it is not. To force signing and error if
the key is missing, run `bun run sign` on its own. Overrides: pass a dist path as
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
