# The desktop app, built from source.
#
# For NixOS users, and for anyone who wants a build that fetches nothing at build time and
# produces the same bytes twice. This is a genuine source build: the Rust binary and the frontend
# are both compiled here, not lifted out of the .deb we publish to apt.bramble.sh.
#
# It deliberately does NOT self-update: a Nix store path is read-only, so the updater could never
# replace anything. The app already knows — `can_self_update()` is false without `APPIMAGE` in the
# environment — so Settings says the package manager keeps it current and offers no update check.
# See docs/desktop-port.md.

{
  lib,
  stdenv,
  rustPlatform,
  cargo-tauri,
  nodejs,
  fetchPnpmDeps,
  pnpm_10,
  pnpmConfigHook,
  pkg-config,
  wrapGAppsHook3,
  webkitgtk_4_1,
  openssl,
  dbus,
  glib-networking,
  libayatana-appindicator,
  librsvg,
  xdotool,
  src ? ../../..,
}:

let
  # One version number, read from the file that already holds it, so a release bump does not have
  # to remember this package exists.
  tauriConf = lib.importJSON ../src-tauri/tauri.conf.json;
in
rustPlatform.buildRustPackage (finalAttrs: {
  pname = "bramble";
  version = tauriConf.version;

  inherit src;

  # The workspace root is the pnpm root; the crate is four levels in.
  cargoRoot = "packages/platform-desktop/src-tauri";
  buildAndTestSubdir = finalAttrs.cargoRoot;

  # By lockfile rather than by cargoHash: every dependency is a registry crate (no git sources),
  # so there is no vendor hash to regenerate on each bump, and Cargo.lock is already the thing
  # that decides what gets built.
  cargoLock.lockFile = ../src-tauri/Cargo.lock;

  # The top-level helpers, not `pnpm_10.fetchDeps` / `pnpm_10.configHook`: those attributes are
  # deprecated and warn on every evaluation. `pnpm_10` is still passed, to pin the pnpm the store
  # is built with to the one the lockfile was written by.
  pnpmDeps = fetchPnpmDeps {
    inherit (finalAttrs) pname version src;
    pnpm = pnpm_10;
    fetcherVersion = 3;
    hash = "sha256-N09AJYkab+fnGYhLHI0BtCUSNWfdb2NUvACfcCoT0bA=";
  };

  postPatch = ''
    # Updater artifacts are signed at bundle time and there is no key here, which would fail the
    # build. Nothing is lost: this install cannot self-update anyway, and an unsigned updater
    # archive is worse than none.
    substituteInPlace packages/platform-desktop/src-tauri/tauri.conf.json \
      --replace-fail '"createUpdaterArtifacts": true' '"createUpdaterArtifacts": false'
  '';

  nativeBuildInputs = [
    cargo-tauri.hook
    nodejs
    # pnpm itself as well as the hook: the top-level hook, unlike the versioned `pnpm_10.configHook`
    # it replaces, does not bring a pnpm with it and fails at configure time without one.
    pnpm_10
    pnpmConfigHook
    pkg-config
    wrapGAppsHook3
  ];

  buildInputs = [
    webkitgtk_4_1
    openssl
    dbus # the Secret Service tier of the credential store
    glib-networking
    libayatana-appindicator # the tray
    librsvg
    xdotool # the global shortcut
  ];

  # The crate's own tests need no display and are worth running here, but they are the shell's,
  # not the workspace's: `pnpm test` belongs to CI.
  doCheck = true;

  meta = {
    description = "Offline-first password manager with direct device-to-device sync";
    homepage = "https://bramble.sh";
    license = lib.licenses.gpl3Only;
    mainProgram = "bramble-desktop";
    platforms = lib.platforms.linux;
  };
})
