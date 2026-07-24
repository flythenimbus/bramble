# Reproducible Android build environment that mirrors F-Droid's buildserver, so a
# release built here is byte-identical to what fdroiddata CI produces from the same
# tag. F-Droid's reproducible-build check diffs the two APKs and, on a match,
# publishes OUR signed binary instead of one signed with F-Droid's key.
#
# Why amd64 (linux/amd64, so it runs under emulation on Apple Silicon): the Android
# NDK's clang is an x86_64 binary that bakes its own build id into the compiled .so,
# and F-Droid builds on x86_64. An arm64 build could never match. Rosetta/qemu
# translate x86_64 deterministically, so emulated output equals native x86_64 output.
#
# Everything here is pinned to what F-Droid's recipe installs, so the toolchains match:
#   - Debian trixie (F-Droid's buildserver base)
#   - nodejs from apt (trixie ships 20.19.x, satisfying our rolldown engine floor)
#   - Rust 1.95.0 via rustup (rust-toolchain.toml pins it)
#   - cargo-ndk + wasm-pack pinned to the versions in the fdroiddata build log
#   - NDK 27.1.12297006 (r27b), the version the recipe requests
FROM --platform=linux/amd64 debian:trixie

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git unzip xz-utils \
      build-essential pkg-config libssl-dev \
      nodejs npm \
      openjdk-21-jdk-headless \
    && rm -rf /var/lib/apt/lists/*

# pnpm pinned via npm, matching the recipe's `npm install -g pnpm@10.33.0`.
RUN npm install -g pnpm@10.33.0

# Rust: rustup installs the toolchain rust-toolchain.toml pins (1.95.0) on first use;
# add it explicitly plus the Android targets and the cross-compile tooling. cargo-ndk
# and wasm-pack are pinned to the versions F-Droid's last build installed, so the
# generated .so / wasm-bindgen glue match.
ENV RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo PATH=/opt/cargo/bin:$PATH
RUN curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain 1.95.0 \
    && rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android i686-linux-android \
    && cargo install cargo-ndk@4.1.2 wasm-pack@0.15.0 --locked

# Android SDK command-line tools + platform 36 + NDK r27b. build-tools are left for
# Gradle/AGP to fetch (it pins the exact version, same as on F-Droid's server).
ENV ANDROID_HOME=/opt/android-sdk ANDROID_SDK_ROOT=/opt/android-sdk
ENV ANDROID_NDK_HOME=/opt/android-sdk/ndk/27.1.12297006
ENV JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64
RUN mkdir -p "$ANDROID_HOME/cmdline-tools" \
    && curl -fsSL -o /tmp/cmdtools.zip https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip \
    && unzip -q /tmp/cmdtools.zip -d "$ANDROID_HOME/cmdline-tools" \
    && mv "$ANDROID_HOME/cmdline-tools/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest" \
    && yes | "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --licenses >/dev/null \
    && "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" \
        "platform-tools" "platforms;android-36" "ndk;27.1.12297006" >/dev/null \
    && rm /tmp/cmdtools.zip
ENV PATH=$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH
