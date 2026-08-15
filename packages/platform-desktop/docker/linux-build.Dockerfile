# syntax=docker/dockerfile:1
#
# Linux artifacts (.deb, .rpm, AppImage) built on Linux, from any host.
#
# The maintainer's machine is a Mac, and a Debian package has to be built on Debian: the bundler
# shells out to dpkg-deb, and the binary links against a specific glibc and webkit2gtk. So this
# image is the Linux half of the release, driven by scripts/build-linux.ts.
#
# **Ubuntu 22.04 on purpose, not something current.** A binary cannot run on an older glibc than
# the one it was linked against, so the build distribution sets the floor for every user: building
# on trixie (glibc 2.41) would produce a .deb that refuses to install on Ubuntu 22.04 or Debian 12,
# which is most of the people who would install it. 22.04 is the oldest release carrying
# webkit2gtk-4.1, which Tauri v2 requires, so it is the floor available to us.
#
# What is deliberately NOT here: signing. The updater key arrives through the environment for the
# one build that needs it, and the APT repository's GPG key never comes near a container at all —
# it lives on a YubiKey, and Docker Desktop on macOS cannot pass a USB device through. Signing and
# publishing stay on the host. See docs/release-signing.md.

FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# Tauri's Linux prerequisites, plus libdbus (the Secret Service backend of the credential store),
# libxdo (tray and global shortcut), rsync (see the workspace copy in build-linux.ts), and
# xdg-utils, which the deb bundler copies xdg-open OUT of for tauri-plugin-opener. GitHub runners
# ship that already, so a clean container is the only place its absence shows up.
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      curl \
      file \
      git \
      libayatana-appindicator3-dev \
      libdbus-1-dev \
      librsvg2-dev \
      libssl-dev \
      libwebkit2gtk-4.1-dev \
      libxdo-dev \
      pkg-config \
      rsync \
      xdg-utils \
      xz-utils \
    && rm -rf /var/lib/apt/lists/*

# Node from the official tarball rather than a distro package: 22.04 ships far too old a version,
# and this keeps the runtime the same one CI and the Mac use.
ARG NODE_VERSION=24.19.0
ARG TARGETARCH
RUN case "${TARGETARCH:-amd64}" in \
      amd64) NODE_ARCH=x64 ;; \
      arm64) NODE_ARCH=arm64 ;; \
      *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" \
      | tar -xJ -C /usr/local --strip-components=1 \
    && corepack enable

# No toolchain installed here: rust-toolchain.toml pins the version, and rustup fetches exactly
# that on the first cargo invocation. Pinning one in the image too would give two sources of truth
# and a silent mismatch the day the file changes.
ENV RUSTUP_HOME=/opt/rustup \
    CARGO_HOME=/opt/cargo \
    PATH=/opt/cargo/bin:/usr/local/bin:$PATH
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --no-modify-path --default-toolchain none --profile minimal \
    && chmod -R a+rwX /opt/rustup /opt/cargo

# The container runs as the invoking user (see build-linux.ts) so that everything it writes to the
# mounted output directory is owned by them rather than by root. That user has no entry in
# /etc/passwd, so give the tools somewhere writable to call home.
RUN mkdir -p /work /out /home/builder && chmod -R a+rwX /work /out /home/builder
ENV HOME=/home/builder
WORKDIR /work
