# APT releases (`apt.bramble.sh`)

How a Debian or Ubuntu user installs Bramble and keeps it current, and how a release gets there.
The signing keys themselves are described in [release-signing.md](release-signing.md); this is the
end-to-end flow, written as a runbook, with the failures that actually happened while building it.

## What a user runs

```bash
curl -fsSL https://apt.bramble.sh/keys.asc | sudo tee /usr/share/keyrings/bramble-keyring.asc > /dev/null
curl -fsSL https://apt.bramble.sh/bramble.sources | sudo tee /etc/apt/sources.list.d/bramble.sources > /dev/null
sudo apt update && sudo apt install bramble
```

Three steps because they are three separate trust decisions: fetch the key, scope it to one
repository, then install. `bramble.sources` is deb822 and its `Signed-By:` line is the scoping —
without it, a key installed for Bramble could authenticate a package from anywhere else on the
system.

Those same three commands are what the download box on the front page hands a Linux visitor, from
`website/src/downloads.ts`. Change them here and change them there.

## Why a repository rather than a `.deb` on the release page

A downloaded `.deb` installs once and then rots. Bramble is distributed outside any store, so
without a channel that updates, a security fix reaches only the people who think to check the
repository. The desktop app self-updates (see [desktop-port.md](desktop-port.md)), but **a
dpkg-managed install cannot**: the updater would have to replace files a package manager owns. So
for Debian and Ubuntu the package manager *is* the update channel, and the app stands down and
says nothing about updates when it detects it was installed that way.

## Where each piece runs, and why

| Step | Runs | Why there |
|---|---|---|
| Build `.deb` / `.rpm` / AppImage | Container (`pnpm run build:linux`) | A Debian package has to be built on Debian; the maintainer's machine is a Mac |
| Sign the index, upload | Host (`pnpm run publish:apt`) | The GPG key is on a YubiKey, and Docker Desktop on macOS cannot pass a USB device through |
| Verify the published result | CI (`verify-apt-repository`) | It runs against the live URL, so it also catches a half-finished upload |

**`pnpm release desktop` now drives all of this from one machine**, so the two build commands above
are what a release runs rather than what you type. From a Mac it builds macOS natively, then the
Linux packages in the container, attaches every artifact to the one GitHub release, writes
`latest.json` with both the darwin and `linux-x86_64` keys, and finishes with `publish:apt`. The
updater key is unlocked once for both builds, so a release is one YubiKey touch for signing plus
two for the APT index. If the APT step fails the release is still valid and complete; re-run
`pnpm run publish:apt`.

That split is forced rather than chosen. Everything that must be Linux is in the container;
everything that must be near a key is on the host. aptly and rclone are cross-platform, and aptly
builds a Debian index without dpkg, so nothing in the publishing half needs Linux.

## Hosting

Cloudflare R2 (`bramble-apt`) behind the custom domain `apt.bramble.sh`. Not the website's
Cloudflare Pages deployment and not `website/public/`: every release adds a ~10 MB `.deb`, which
in git is permanent, and Pages caps a file at 25 MiB anyway.

Two cache rules on that hostname, which matter more than they look:

| Path | Rule | Why |
|---|---|---|
| `/dists/*` | Bypass cache | The index. A cached `InRelease` means `apt update` reports no new version, indefinitely |
| `/pool/*` | Eligible for cache, Edge TTL 1 month, ignore origin cache-control | Filenames carry the version, so they never change. R2 sends no `Cache-Control` of its own, which is why the TTL has to be an override rather than "respect origin" |

A `curl -I` against `/dists/` reports `cf-cache-status: DYNAMIC` rather than `BYPASS`. That is
expected and not a broken rule: Cloudflare says BYPASS only when a rule prevents caching something
otherwise cacheable, and these extensionless files were never cacheable by default.

## One-time setup

### Cloudflare

1. R2 → create bucket `bramble-apt`.
2. Bucket → Settings → Public access → Custom Domains → connect `apt.bramble.sh`. Leave the
   `r2.dev` URL off; it is rate-limited and not something to put in install instructions.
3. The two cache rules above.
4. R2 → API → create a token with **Object Read & Write**, scoped to that bucket.

A token scoped to one bucket cannot list buckets, so `rclone lsd r2:` returns 403 while
`rclone ls r2:bramble-apt` works. That 403 is not a credential problem.

### The signing key

On the YubiKey's OpenPGP applet, which is a different applet from the PIV one `age-plugin-yubikey`
uses; the same token carries both. Full rationale and the generation steps are in
[release-signing.md](release-signing.md#linux-apt-repository-aptbramblesh). In short: Ed25519,
generated on-card with no off-card backup, `ykman openpgp keys set-touch sig on`.

### Tools

```bash
# Debian
sudo apt install aptly rclone scdaemon xdg-utils rsync

# macOS
brew install aptly rclone gnupg pinentry-mac ykman
echo "pinentry-program $(brew --prefix)/bin/pinentry-mac" >> ~/.gnupg/gpg-agent.conf
gpgconf --kill gpg-agent
```

Plus Docker for `build:linux`. `rsync` and `xdg-utils` are Linux-only needs (`release.ts` checks
for them there): the deb bundler copies `xdg-open` into the package for tauri-plugin-opener, and
the container build rsyncs the tree into its workspace.

### `.env.local`

```
BRAMBLE_APT_GPG_KEY=<fingerprint of the repository signing key>
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
```

rclone is configured from those variables at run time, so there is no `rclone.conf` to keep in
sync and no credential written to disk by the release.

### Moving to another machine

The private half is on the card, but gpg will not create the card stub until it has the public
key. Export it from a machine that has it, then on the new one, with the YubiKey plugged in:

```bash
gpg --import bramble-apt.asc
gpg --card-status                              # creates the sec> stub
gpg --list-secret-keys --keyid-format=long     # expect  sec>  ed25519/...
```

## Releasing

```bash
pnpm run build:linux        # container. One touch, for the updater key
pnpm run publish:apt        # host. TWO touches: Release.gpg and InRelease are signed separately
```

`build:linux --unsigned` builds with a throwaway updater key for iterating. The result installs
and can never self-update, so it is not publishable.

`publish:apt --dry-run` does everything except the upload, leaving the signed tree in
`~/.aptly/public` to inspect. Worth doing the first time on any new machine.

What publish does, in order:

1. Creates the aptly repo on first use, then `repo add -force-replace` for each `.deb` in
   `dist-linux/deb/`, so a re-run after a half-failed release is not an error.
2. Asserts aptly's `gpgProvider` is `"gpg"`. Its built-in Go OpenPGP implementation cannot talk to
   a smartcard and reports a missing secret key for a key that is plainly there.
3. `publish repo` (first time) or `publish update` (after), signing `Release`.
4. Exports `keys.asc` from whatever key actually signed, rather than from a committed copy: the
   two drifting apart is a repository nobody can verify, and the error reads like a network fault.
5. Uploads `pool/` **then** `dists/`. The index names packages by path, so the other order leaves
   a window where apt is told about a file that is not there yet.

## Layout

```
keys.asc
bramble.sources
dists/stable/{InRelease,Release,Release.gpg}
dists/stable/main/binary-amd64/{Packages,Packages.gz,Packages.bz2,Release}
pool/main/b/bramble/bramble_<version>_amd64.deb
```

`stable` is the suite named in `bramble.sources`. Changing it orphans every installed client.

## Verifying

What apt trusts is the signature on the index, not the packages: a `.deb` is verified by its
checksum in `Packages`, which is covered by `Release`, which is signed. The whole chain, from a
cold fetch:

```bash
curl -fsSL https://apt.bramble.sh/keys.asc | gpg --dearmor > /tmp/k.gpg
curl -fsSL https://apt.bramble.sh/dists/stable/InRelease -o /tmp/InRelease
gpgv --keyring /tmp/k.gpg /tmp/InRelease          # Good signature from "Bramble <...>"

curl -fsSL https://apt.bramble.sh/dists/stable/main/binary-amd64/Packages -o /tmp/Packages
sha256sum /tmp/Packages                            # matches the SHA256 line in InRelease
grep -E "^(Filename|SHA256):" /tmp/Packages        # matches sha256sum of the downloaded .deb
```

`--keyring` needs a path containing a slash. Given a bare filename, gpgv looks in `~/.gnupg/`
rather than the working directory and reports "No public key" for a key that is right there.

CI does the same on release-published (`verify-apt-repository`): `gpgv` against the published
key, then a HEAD on every `Filename:` in `Packages`.

## Troubleshooting

Everything here was hit at least once while setting this up.

**`gpg: No SmartCard daemon`** — Debian splits scdaemon out of gnupg. `sudo apt install scdaemon`
then `gpgconf --kill all`.

**`gpg: selecting card failed: No such device`, but `ykman info` sees the key** — pcscd already
holds the card (it is there for PIV/age) and scdaemon's built-in CCID driver cannot also claim it.
Put `disable-ccid` in `~/.gnupg/scdaemon.conf` and `gpgconf --kill all`, so scdaemon goes through
pcscd and both can coexist. Do not stop pcscd; that breaks age.

**`Bad PIN` on `key-attr`** — it wants the **Admin** PIN, not the user PIN. Watch the retry
counters (`gpg --card-status | grep "PIN retry"`: user, reset code, admin) and stop at 1. A
blocked admin PIN with no keys on the card yet costs nothing: `ykman openpgp reset`, then set both
PINs with `ykman openpgp access change-pin` / `change-admin-pin`, which name which PIN they are
changing and enforce the length limits (6+ user, 8+ admin) instead of quietly leaving the old one
in force. `ykman openpgp access set-retries 5 5 5` is worth doing at the same time.

**`gpg: signing failed: Timeout`** — the card is waiting for a touch. Not a PIN or pinentry
problem. Remember `publish update` needs two.

**Everything published into a directory called `-gpg-key=...`** — aptly's flag parser stops at the
first positional, so `publish repo bramble -gpg-key=FPR` reads the flag as the *prefix* argument.
Flags go before positionals. It exits 0 and signs correctly, so the only symptom is that `dists/`
is not where anything looks for it. Recover with
`aptly publish drop stable '-gpg-key=<fpr>'` and delete the stray directory.

**`NotImplemented: 501` on every rclone transfer, succeeding on retry** — R2 does not implement
what rclone does by default after an upload (setting a modtime, via a server-side copy). The
publish script passes `--checksum` and `--s3-no-head` to avoid both. Without them it still works,
which is the trap: a release log that always carries errors is one nobody reads when there is a
real one.

## Not done yet

- **arm64.** amd64 only, like Signal. The container takes `--platform`, so an arm64 package is a
  runner (or an emulated build) away rather than new code.
- **A `.deb` built in CI.** Tempting, since apt trusts the signed index rather than the package,
  so no key would be needed to build one. It would mean signing an artifact this machine did not
  produce, which is a different trust story than every other target here.
- **Publishing the AppImage through the repository.** It cannot be: apt installs packages. The
  AppImage stays a GitHub release asset, and it is the only Linux artifact that self-updates.
