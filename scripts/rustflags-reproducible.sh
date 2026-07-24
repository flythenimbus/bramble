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

# std paths need care. A toolchain WITHOUT the rust-src component (a plain CI install)
# already emits the canonical /rustc/<commit-hash>/library/..., but one WITH rust-src
# installed emits the local <sysroot>/lib/rustlib/src/rust/library/... instead. Remap the
# latter onto the former so both hosts agree, rather than inventing a third form.
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cargo_home="${CARGO_HOME:-$HOME/.cargo}"
rust_src="$(rustc --print sysroot)/lib/rustlib/src/rust"
commit="$(rustc --version --verbose | sed -n 's/^commit-hash: //p')"
printf -- '--remap-path-prefix=%s=/bramble --remap-path-prefix=%s=/cargo --remap-path-prefix=%s=/rustc/%s' \
	"$root" "$cargo_home" "$rust_src" "$commit"
