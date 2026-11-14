# Bramble Desktop for AppMan

This directory contains a local AppMan installer recipe for Bramble's Linux
AppImage. It follows AppMan's generated shell-script conventions (`APP`,
`SITE`, `/opt/$APP`, `AM-updater`, `version`, and `remove`), with Bramble's
manifest and release signature checks added. The recipe can be hand-authored;
`appman -t bramble` is an optional way to generate a starting template, not a
required compiler or registration step.

## Install with AppMan

The installer needs `curl` and `jq` to read Bramble's release manifest.
Signature verification is enabled by default and also needs `minisign` and
`base64` (`base64` is commonly provided by `coreutils`). Install the required
tools with your distribution's package manager in the environment where
AppMan runs. `minisign` is optional only if you explicitly skip verification.
For example:

```sh
# Debian or Ubuntu
sudo apt install curl jq coreutils
sudo apt install minisign  # recommended: verifies the downloaded AppImage
# Fedora
sudo dnf install curl jq coreutils
sudo dnf install minisign  # recommended: verifies the downloaded AppImage

appman
appman -i /path/to/bramble/packaging/appman-bramble/bramble
```

If you cannot install `minisign`, you can skip signature verification for the
initial install:

```sh
BRAMBLE_SKIP_VERIFICATION=1 appman -i /path/to/bramble/packaging/appman-bramble/bramble
```

This bypasses the check that authenticates the downloaded AppImage. AppMan's
script-path install does not pass extra command-line arguments to the recipe,
so use the environment variable when installing through AppMan. Future AppMan
updates still require `minisign` and verify the new AppImage.

The first `appman` run asks where to store applications if AppMan has not been
configured yet. Its rootless install command accepts a script path and adapts
the conventional system paths in this recipe to its configured user-owned
locations. Future updates can be requested with:

```sh
appman -u bramble
```

The recipe supports `x86_64`/`amd64` and `aarch64`/`arm64`; it rejects other
architectures. It reads the current version and exact per-architecture URL from
`https://bramble.sh/desktop/latest.json`, checks that the URL agrees with the
versioned `<version>-desktop` release naming convention, downloads the
AppImage and its adjacent `.sig`, verifies the Tauri-wrapped minisign signature
against the updater public key embedded in Bramble, and only then replaces the
installed image. `version` records the release version used by AppMan's update
comparison. The updater stages and verifies the new image before replacing the
old one. The generated desktop entry is conditional on extracting the AppImage
icon successfully.

AppMan creates its package launcher in the environment where it runs. If that
environment is a container, exporting the launcher to the host desktop and
confirming GUI launch behavior are separate integration steps not covered by
this recipe.

## Trust and maintenance

The AppImage is verified with the same minisign public key compiled into
Bramble's Tauri updater configuration. The current `.sig` asset is a
base64-wrapped minisign signature, so the recipe unwraps it before invoking
`minisign`. The HTTPS update manifest chooses the artifact and release version;
the detached signature independently authenticates the downloaded AppImage.
The recipe intentionally does not depend on `SHA256SUMS`, which is not an
independent trust source for an artifact hosted alongside it.

If Bramble changes its Linux asset names, manifest keys, updater key, or
signature encoding, update this recipe to match the release pipeline.

References:

- [AppMan template guide](https://github.com/ivan-hc/AM/blob/main/docs/guides-and-tutorials/template.md)
- [AppMan install guide](https://github.com/ivan-hc/AM/blob/main/docs/guides-and-tutorials/install.md)
- [Bramble desktop update manifest](https://bramble.sh/desktop/latest.json)
- [Bramble updater verification implementation](../../scripts/verify-updater-signature.mjs)
