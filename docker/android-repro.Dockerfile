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
# Everything is pinned to what F-Droid's recipe installs, so the toolchains match:
#   - Debian trixie (F-Droid's buildserver base)
#   - Node 22.23.1 from the official nodejs.org binary. NOT Debian's apt nodejs: trixie
#     ships 20.19, which clears rolldown's engine floor but not Capacitor's CLI (>=22).
#   - Rust 1.95.0 via rustup (rust-toolchain.toml pins it)
#   - cargo-ndk + wasm-pack pinned to the versions in the fdroiddata build log
#   - NDK 27.1.12297006 (r27b), the version the recipe requests
FROM --platform=linux/amd64 debian:trixie

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git unzip xz-utils \
      build-essential pkg-config libssl-dev \
      openjdk-21-jdk-headless \
    && rm -rf /var/lib/apt/lists/*

# Rust: rustup installs the toolchain rust-toolchain.toml pins (1.95.0); add it plus the
# Android targets and cross-compile tooling. cargo-ndk and wasm-pack are pinned to the
# versions F-Droid's last build installed, so the generated .so / wasm-bindgen glue match.
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

# Node last (cheap to re-pin): the official binary, matching the recipe's version, plus
# pnpm. /usr/local/bin is ahead of /usr/bin on PATH so these win.
RUN install -d /opt/node \
    && curl -fsSL https://nodejs.org/dist/v22.23.1/node-v22.23.1-linux-x64.tar.xz \
        | tar -xJ --strip-components=1 -C /opt/node \
    && ln -sf /opt/node/bin/node /opt/node/bin/npm /opt/node/bin/npx /usr/local/bin/ \
    && /opt/node/bin/npm install -g pnpm@10.33.0 \
    && ln -sf /opt/node/bin/pnpm /usr/local/bin/pnpm
