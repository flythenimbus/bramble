#!/usr/bin/env bash
# Build the flake and assert what it produced, in a container with nothing of ours in it.
#
# Run by scripts/test-nix-build.ts; runnable by hand inside nixos/nix with the repo at /src.
#
# The build succeeding is most of the test — a Nix build fetches nothing at build time, so a
# missing dependency or a step that reached for the network fails rather than silently working
# the way it does on a developer's machine. The assertions below cover what a successful build can
# still get wrong.

set -euo pipefail

say() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
ok() { printf '  ok: %s\n' "$1"; }
die() {
	printf '  FAIL: %s\n' "$1" >&2
	exit 1
}

NIX=(nix --extra-experimental-features "nix-command flakes")

# Copied out of the read-only mount: the build needs a writable tree, and a stale node_modules or
# target/ from the host would be both wrong for this platform and enormous to copy.
say "preparing a clean tree"
mkdir -p /tmp/build && cp -r /src/. /tmp/build/ && cd /tmp/build
rm -rf node_modules dist dist-linux dist-chromium packages/*/node_modules \
	packages/platform-desktop/src-tauri/target packages/core-rust/target
ok "tree at /tmp/build"

say "nix build .#bramble"
OUT="$("${NIX[@]}" build .#bramble --no-link --print-out-paths)"
[ -n "$OUT" ] || die "no output path"
ok "$OUT"

say "what the derivation installed"
[ -x "$OUT/bin/bramble-desktop" ] || die "no executable at bin/bramble-desktop"
ok "bin/bramble-desktop"

# The same property the .deb test checks: manifest.rs resolves the native-messaging proxy as a
# sibling of the running executable, so a package that installs one without the other leaves the
# browser link silently broken.
[ -x "$OUT/bin/bramble-proxy" ] || die "no proxy beside the binary"
ok "bin/bramble-proxy is beside it"

[ -f "$OUT/share/applications/Bramble.desktop" ] || die "no .desktop entry"
ok "share/applications/Bramble.desktop"
find "$OUT/share/icons" -name '*.png' | grep -q . || die "no icons installed"
ok "icons installed"

# wrapGAppsHook3 replaces the binary with a wrapper that sets the GTK/webkit environment. Without
# it the app starts and then cannot render, which is not a failure any build-time check would see.
say "the launcher is wrapped"
grep -q "bramble-desktop-wrapped" "$OUT/bin/bramble-desktop" 2>/dev/null ||
	file "$OUT/bin/bramble-desktop" | grep -q "shell script" ||
	die "bin/bramble-desktop is not a wrapper; the GTK environment would be unset"
[ -x "$OUT/bin/.bramble-desktop-wrapped" ] || die "no wrapped binary behind the launcher"
ok "wrapper + .bramble-desktop-wrapped"

# A store path is read-only, so the updater could never replace anything, and the app knows: it
# reports no updater unless APPIMAGE is set. The string is compiled in either way; what this
# checks is that the binary is the real one and not a stub.
say "the binary is real"
SIZE="$(stat -c%s "$OUT/bin/.bramble-desktop-wrapped")"
[ "$SIZE" -gt 5000000 ] || die "binary is only $SIZE bytes; a stub, not a build"
ok "$((SIZE / 1024 / 1024)) MB"

# Nix patches the interpreter and rpath; anything unresolved here would be a missing buildInput
# that happens to exist on the builder. This image ships no ldd of its own, and a check that
# cannot run should say so rather than print an ok.
if command -v ldd >/dev/null 2>&1; then
	if ldd "$OUT/bin/.bramble-desktop-wrapped" | grep -q "not found"; then
		ldd "$OUT/bin/.bramble-desktop-wrapped" | grep "not found"
		die "unresolved shared libraries"
	fi
	ok "no unresolved shared libraries"
else
	printf '  skipped: no ldd in this image\n'
fi

# The tray library is not one ldd could report either way: libappindicator-sys reaches for it with
# dlopen(), so it is never a DT_NEEDED entry, and the only thing that makes it resolvable at
# startup is the store path nix/package.nix puts on the binary's RUNPATH. That path is a plain
# string in the binary, which is what this matches. Without it the app builds, installs, passes
# every check above, and then panics on launch, which is exactly how it shipped broken.
say "the dlopen'd tray library"
TRAY="$(grep -ao "/nix/store/[0-9a-z]\{32\}-libayatana-appindicator[0-9A-Za-z.+_-]*/lib" \
	"$OUT/bin/.bramble-desktop-wrapped" | head -1 || true)"
[ -n "$TRAY" ] || die "no libayatana-appindicator on the RUNPATH; the tray dlopen would fail at startup"
[ -e "$TRAY/libayatana-appindicator3.so.1" ] || die "$TRAY holds no libayatana-appindicator3.so.1"
ok "libayatana-appindicator3.so.1 via $TRAY"

# Closure size is reported rather than asserted: a jump usually means a dependency crept in
# through a wrapper, and nobody notices until someone downloads it. No awk in this image, hence
# the shell arithmetic.
say "closure"
BYTES="$("${NIX[@]}" path-info -S "$OUT" | tr -s ' ' | cut -d' ' -f2)"
case "$BYTES" in
	'' | *[!0-9]*) printf '  (could not measure)\n' ;;
	*) printf '  %s MB including dependencies\n' "$((BYTES / 1024 / 1024))" ;;
esac

printf '\n\033[1;32mPASS\033[0m %s\n' "$(basename "$OUT" | cut -d- -f2-)"
