#!/usr/bin/env bash
# Runs INSIDE the android-repro container (see docker-compose.yml). Clean-clones the
# given git ref from the read-only /src mount and builds the unsigned release APK the
# same way F-Droid's recipe does, then drops it in /out (-> ./build-fdroid/ on the host).
#
# Cloning (rather than building the mounted tree) mirrors F-Droid, which builds a fresh
# checkout of the tag, and keeps the host working tree free of Linux build artifacts.
#
# The result is UNSIGNED on purpose: sign it on the host with the YubiKey keystore.
# F-Droid strips signatures before its byte comparison, so where you sign is irrelevant
# to reproducibility -- only the built content has to match.
#
#   docker compose run --rm android-repro 0.9.4-android
#   # then, on the host:
#   apksigner sign --ks <keystore> --out bramble_android_0.9.4.apk \
#     build-fdroid/app-release-unsigned.apk
set -euxo pipefail

ref="${1:?usage: docker compose run --rm android-repro <git-ref, e.g. 0.9.4-android>}"

rm -rf /build
git clone --quiet /src /build
cd /build
git checkout --quiet "$ref"
echo "==> building $(git describe --tags 2>/dev/null || git rev-parse --short HEAD)"

pnpm config set store-dir /pnpm-store
pnpm install --frozen-lockfile
pnpm run core:build                                         # wasm-pack + vite
pnpm run ffi:build:android                                  # cargo-ndk (4 ABIs) + uniffi
pnpm --filter @vault/platform-mobile exec cap sync android
( cd packages/platform-mobile/android \
    && ./gradlew --no-daemon assembleRelease \
        "-Porg.gradle.java.installations.paths=$JAVA_HOME" )

apk="packages/platform-mobile/android/app/build/outputs/apk/release/app-release-unsigned.apk"
cp "$apk" /out/
echo "==> unsigned APK copied to ./build-fdroid/$(basename "$apk"); sign it on the host"
