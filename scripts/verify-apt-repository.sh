#!/usr/bin/env bash
# Check the live APT repository the way apt will: the index verifies against the published key,
# and every package it names is actually there. Run by release.yml and apt-release.yml.
#
# What apt trusts is the signature on the index, not the packages: a .deb is verified by its
# checksum in Packages, which is covered by Release, which is signed. So a repository whose
# InRelease does not verify against the published key is one that installs nothing, and the
# failure surfaces to users as "the following signatures were invalid" long after the fact. This
# runs against the live repository, so it also catches a half-finished upload.
set -euo pipefail

base="https://apt.bramble.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

curl -fsSL "$base/keys.asc" | gpg --dearmor > "$work/bramble.gpg"
curl -fsSL "$base/dists/stable/InRelease" > "$work/InRelease"
gpgv --keyring "$work/bramble.gpg" "$work/InRelease"
echo "ok: InRelease verifies"

# The index names packages by path and checksum; a pool file that is missing (or was overwritten
# by a later sync) makes `apt install` fail on a package apt was just told about.
#
# Every architecture the repository claims, not just amd64: checking one of them is how the arm64
# packages stayed unreachable for two releases. The architectures come from the sources snippet
# users actually install, so this fails if it stops matching the index as well.
arches="$(curl -fsSL "$base/bramble.sources" | sed -n 's/^Architectures: //p')"
[ -n "$arches" ] || { echo "::error::bramble.sources names no architectures"; exit 1; }
for arch in $arches; do
	echo "-- $arch"
	curl -fsSL "$base/dists/stable/main/binary-$arch/Packages" > "$work/Packages"
	grep -q '^Filename:' "$work/Packages" || { echo "::error::binary-$arch names no packages"; exit 1; }
	grep '^Filename:' "$work/Packages" | awk '{print $2}' | while read -r path; do
		code="$(curl -s -o /dev/null -w '%{http_code}' -I "$base/$path")"
		[ "$code" = "200" ] || { echo "::error::$path is $code"; exit 1; }
		echo "ok: $path"
	done
done
