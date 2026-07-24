#!/usr/bin/env bash
# Echo the rustc flags that make our Rust output independent of where the repo is
# checked out, so a release built here matches one F-Droid's buildserver rebuilds
# from the same tag (its reproducible-build check diffs the two APKs).
#
# `strip = true` only drops debug symbols; rustc still bakes absolute file!() paths
# into .rodata for panic locations, so /Users/<me>/... and /home/vagrant/build/...
# produce different bytes. Remap the checkout root and the cargo registry to fixed
# placeholders. std paths are already remapped by rustc to /rustc/<hash>/.
#
# Cargo's `trim-paths` profile option would express this declaratively, but it is
# still nightly-only as of Cargo 1.95, hence doing it via RUSTFLAGS.
set -euo pipefail

# The sysroot is remapped too, and it must be resolved via `rustc --print sysroot`
# rather than hardcoded: it ends in the HOST triple (…/1.95.0-aarch64-apple-darwin vs
# …-x86_64-unknown-linux-gnu), so only the resolved path collapses both to one value.
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cargo_home="${CARGO_HOME:-$HOME/.cargo}"
sysroot="$(rustc --print sysroot)"
printf -- '--remap-path-prefix=%s=/bramble --remap-path-prefix=%s=/cargo --remap-path-prefix=%s=/rustup' \
	"$root" "$cargo_home" "$sysroot"
