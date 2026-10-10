# macOS desktop build (WKWebView, aarch64-darwin only, .dmg bundle).
# Linux parts remain untouched in package.nix.
{
  lib,
  rustPlatform,
  cargo-tauri,
  nodejs,
  fetchPnpmDeps,
  pnpm_10,
  pnpmConfigHook,
  pkg-config,
  src ? ../../..,
}:

let
  tauriConf = lib.importJSON ../src-tauri/tauri.conf.json;
in
rustPlatform.buildRustPackage (finalAttrs: {
  pname = "bramble-desktop";
  version = tauriConf.version;

  inherit src;

  cargoRoot = "packages/platform-desktop/src-tauri";
  buildAndTestSubdir = finalAttrs.cargoRoot;
  cargoLock.lockFile = ../src-tauri/Cargo.lock;

  pnpmDeps = fetchPnpmDeps {
    inherit (finalAttrs) pname version src;
    pnpm = pnpm_10;
    fetcherVersion = 3;
    hash = "sha256-DGpZCPhSMdxljSJwUcqNODBM9s/LiOwLrLbLK2L3cVM=";
  };

  postPatch = ''
    substituteInPlace packages/platform-desktop/src-tauri/tauri.conf.json \
      --replace-fail '"createUpdaterArtifacts": true' '"createUpdaterArtifacts": false'
  '';

  nativeBuildInputs = [
    cargo-tauri.hook
    nodejs
    pnpm_10
    pnpmConfigHook
    pkg-config
  ];

  # macOS: no GTK/WebKitGTK, no Linux-specific libs; WKWebView is built-in.
  buildInputs = [
    openssl
  ];

  postInstall = ''
    mkdir -p $out/bin
    ln -s $out/Applications/Bramble.app/Contents/MacOS/bramble-desktop $out/bin/bramble-desktop
  '';

  doCheck = true;

  meta = {
    description = "Offline-first password manager with direct device-to-device sync";
    homepage = "https://bramble.sh";
    license = lib.licenses.gpl3Only;
    mainProgram = "bramble-desktop";
    platforms = lib.platforms.darwin;
  };
})
