# macOS desktop build (WKWebView, aarch64-darwin only, .app bundle).
{
  lib,
  rustPlatform,
  cargo-tauri,
  nodejs,
  fetchPnpmDeps,
  pnpm_10,
  pnpmConfigHook,
  pkg-config,
  openssl,
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
    hash = "sha256-Ng0gKgMR3GSsaQezIsxEt/YgnrdNmTHfbYq1QSPK3mE=";
  };

  postPatch = ''
    substituteInPlace packages/platform-desktop/src-tauri/tauri.conf.json \
      --replace-fail '"createUpdaterArtifacts": true' '"createUpdaterArtifacts": false'

    # Nix owns updates, including bundles copied into /Applications by nix-darwin.
    substituteInPlace packages/platform-desktop/src-tauri/src/lib.rs \
      --replace-fail '!cfg!(target_os = "linux") || std::env::var_os("APPIMAGE").is_some()' 'false'
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
    appExecutables="$out/Applications/Bramble.app/Contents/MacOS"
    for executable in bramble-desktop bramble-proxy; do
      if [ ! -s "$appExecutables/$executable" ] || [ ! -x "$appExecutables/$executable" ]; then
        echo "Missing or non-executable bundled binary: $appExecutables/$executable" >&2
        exit 1
      fi
    done
    mkdir -p "$out/bin"
    ln -s "$appExecutables/bramble-desktop" "$out/bin/bramble-desktop"
  '';

  doCheck = true;

  meta = {
    description = "Offline-first password manager with direct device-to-device sync";
    homepage = "https://bramble.sh";
    license = lib.licenses.gpl3Only;
    mainProgram = "bramble-desktop";
    platforms = [ "aarch64-darwin" ];
  };
})
