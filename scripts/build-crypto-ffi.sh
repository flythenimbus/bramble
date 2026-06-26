#!/usr/bin/env bash
# Build the native FFI artifacts for the shared Rust crypto core (uniffi).
#
# The same `vault-crypto` crate that wasm-pack builds for the webview also builds,
# under `--no-default-features --features ffi`, a native lib that uniffi turns into
# Swift + Kotlin. The autofill credential provider links this (it can't run Argon2id
# in its ~120 MB cap, so it AES-unwraps the biometric-cached VEK natively), and the
# main app uses it under Lockdown Mode (native crypto needs no JIT; WASM does).
#
# Subcommands:
#   bindings   Generate Swift + Kotlin sources only (host build; no device toolchain).
#   ios        + cross-compile the iOS XCFramework (needs Xcode + rustup iOS targets).
#   android    + cross-compile the Android jniLibs (needs the NDK + cargo-ndk).
#   all        bindings + ios + android.
#
# Outputs go to packages/platform-mobile/native-build/ (gitignored, regenerable).
# Wiring these into the Xcode/Gradle projects is the next step (not done here).
set -euo pipefail

cmd="${1:-bindings}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
crate="$here/packages/core-rust"
mobile="$here/packages/platform-mobile"
out="$mobile/native-build"
lib_name="vault_crypto"            # cdylib/staticlib stem (libvault_crypto.*)
ffi="--no-default-features --features ffi"
# iOS additionally builds the native WebRTC data channel (its WKWebView on capacitor://
# has no RTCPeerConnection). Android's WebView has WebRTC, so its build stays lean and
# pays no webrtc-rs size. So: Swift bindings + the iOS staticlib carry `webrtc`; Kotlin
# bindings + the Android .so do not. See docs/p2p-sync.md.
ffi_ios="--no-default-features --features ffi,webrtc"
# Where the built artifacts are installed into the committed native projects
# (gitignored generated paths the Xcode/Gradle projects reference directly).
ios_ffi="$mobile/ios/App/VaultCryptoFFI"
and_jni="$mobile/android/app/src/main/jniLibs"
and_kt="$mobile/android/app/src/main/java/uniffi/vault_crypto"

mkdir -p "$out/swift" "$out/swift-autofill" "$out/kotlin" "$out/ios" "$out/android"

# --- bindings: host build + library-mode bindgen (one feature set per language) ---
# Swift carries webrtc (iOS), Kotlin doesn't (Android). Each language regenerates from a
# host dylib built with its own feature set; the shared target/debug dylib is rebuilt in
# between, so generate each right after its build.
gen_lang() {
  # Separate `local` statements on purpose: the macOS system bash (3.2, what pnpm invokes)
  # expands a `local` line's args before assigning them, so `outdir`'s default can't see `lang`
  # if they share a line (-> "lang: unbound variable" under `set -u`).
  local lang="$1"
  local feats="$2"
  local outdir="${3:-$out/$lang}"
  echo "==> building host cdylib ($feats) for $lang bindgen -> $outdir"
  ( cd "$crate" && cargo build $feats --lib )
  local dylib="$crate/target/debug/lib${lib_name}.dylib"
  [ -f "$dylib" ] || dylib="$crate/target/debug/lib${lib_name}.so"
  ( cd "$crate" && cargo run -q $feats --features uniffi/cli --bin uniffi-bindgen -- \
      generate --library "$dylib" --language "$lang" --no-format --out-dir "$outdir" )
}

gen_bindings() {
  # Full Swift glue (App target): carries the iOS-only webrtc exports.
  gen_lang swift "$ffi_ios"
  # Slim Swift glue (autofill extension): no webrtc. The extension never does sync, so
  # omitting the exports from its glue lets the linker dead-strip the whole
  # webrtc/ICE/DTLS/SCTP/rustls stack from the appex binary, even though it links the same
  # fat xcframework. Halves webrtc's footprint in the ipa. See docs/p2p-sync.md.
  gen_lang swift "$ffi" "$out/swift-autofill"
  gen_lang kotlin "$ffi"
  echo "==> bindings written to $out/{swift,swift-autofill,kotlin}"
}

# --- ios: per-arch staticlib -> XCFramework ---
build_ios() {
  command -v xcodebuild >/dev/null || { echo "error: xcodebuild not found (install Xcode)"; exit 1; }
  local device="aarch64-apple-ios"
  local sim_arm="aarch64-apple-ios-sim"
  local sim_x86="x86_64-apple-ios"
  rustup target add "$device" "$sim_arm" "$sim_x86"
  for t in "$device" "$sim_arm" "$sim_x86"; do
    echo "==> cargo build --release ($t)"
    # iOS carries webrtc (its WebView lacks RTCPeerConnection); the swift glue is
    # generated from the same feature set in gen_bindings, so the symbols line up.
    ( cd "$crate" && cargo build --release $ffi_ios --lib --target "$t" )
  done
  local rel="$crate/target"
  # Fat simulator staticlib (arm64 + x86_64).
  mkdir -p "$out/ios/sim"
  lipo -create \
    "$rel/$sim_arm/release/lib${lib_name}.a" \
    "$rel/$sim_x86/release/lib${lib_name}.a" \
    -output "$out/ios/sim/lib${lib_name}.a"
  # Headers dir: uniffi's C header + a module.modulemap the framework can import.
  local hdr="$out/ios/headers"
  mkdir -p "$hdr"
  cp "$out/swift/${lib_name}FFI.h" "$hdr/"
  cp "$out/swift/${lib_name}FFI.modulemap" "$hdr/module.modulemap"
  rm -rf "$out/ios/VaultCrypto.xcframework"
  xcodebuild -create-xcframework \
    -library "$rel/$device/release/lib${lib_name}.a" -headers "$hdr" \
    -library "$out/ios/sim/lib${lib_name}.a" -headers "$hdr" \
    -output "$out/ios/VaultCrypto.xcframework"
  # Install into the committed iOS project (the App + extension targets link these).
  mkdir -p "$ios_ffi"
  rm -rf "$ios_ffi/VaultCrypto.xcframework"
  cp -R "$out/ios/VaultCrypto.xcframework" "$ios_ffi/VaultCrypto.xcframework"
  cp "$out/swift/${lib_name}.swift" "$ios_ffi/vault_crypto.swift"
  # Slim glue for the autofill extension target (no webrtc -> dead-stripped from its binary).
  cp "$out/swift-autofill/${lib_name}.swift" "$ios_ffi/vault_crypto.autofill.swift"
  echo "==> installed XCFramework + Swift glue (full + autofill-slim) to $ios_ffi"
}

# --- android: jniLibs per ABI via cargo-ndk ---
build_android() {
  command -v cargo-ndk >/dev/null || { echo "error: cargo-ndk not found (cargo install cargo-ndk)"; exit 1; }
  # Auto-resolve the NDK (latest installed) if the env var isn't already set.
  if [ -z "${ANDROID_NDK_HOME:-}" ]; then
    local sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
    ANDROID_NDK_HOME="$(ls -d "$sdk"/ndk/* 2>/dev/null | sort -V | tail -1 || true)"
    [ -n "$ANDROID_NDK_HOME" ] || { echo "error: no NDK found under $sdk/ndk (set ANDROID_NDK_HOME)"; exit 1; }
    export ANDROID_NDK_HOME
    echo "==> using ANDROID_NDK_HOME=$ANDROID_NDK_HOME"
  fi
  rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android i686-linux-android
  echo "==> cargo ndk build --release (arm64-v8a, armeabi-v7a, x86_64, x86)"
  ( cd "$crate" && cargo ndk \
      -t arm64-v8a -t armeabi-v7a -t x86_64 -t x86 \
      -o "$out/android/jniLibs" \
      build --release $ffi --lib )
  # Install into the committed Android project: jniLibs (AGP auto-bundles) + the
  # uniffi Kotlin glue into its package source dir.
  mkdir -p "$and_jni" "$and_kt"
  rm -rf "$and_jni"; cp -R "$out/android/jniLibs" "$and_jni"
  cp "$out/kotlin/uniffi/vault_crypto/vault_crypto.kt" "$and_kt/vault_crypto.kt"
  echo "==> installed jniLibs to $and_jni + Kotlin glue to $and_kt"
}

case "$cmd" in
  bindings) gen_bindings ;;
  ios)      gen_bindings; build_ios ;;
  android)  gen_bindings; build_android ;;
  all)      gen_bindings; build_ios; build_android ;;
  *) echo "usage: $0 {bindings|ios|android|all}"; exit 1 ;;
esac
