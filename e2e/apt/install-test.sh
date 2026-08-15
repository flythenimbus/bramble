#!/usr/bin/env bash
# Install Bramble from apt.bramble.sh the way a user does, in a container that has never seen it,
# and assert the result. Run by scripts/test-apt-install.ts against several base images; runnable
# by hand inside any Debian-ish container.
#
# The commands under test are the ones published on the website and in docs/apt-releases.md. If
# they change there, change them here: the point of this file is that nobody has to trust that the
# snippet in the docs still works.

set -euo pipefail

BASE="${1:-unknown}"
say() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
ok() { printf '  ok: %s\n' "$1"; }
die() {
	printf '  FAIL: %s\n' "$1" >&2
	exit 1
}

say "$BASE: prerequisites"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
# curl and ca-certificates only. Deliberately NOT gnupg: apt reads the armored key directly
# through Signed-By, and needing gpg to install would make the published snippet a lie.
apt-get install -y -qq --no-install-recommends curl ca-certificates > /dev/null
ok "curl + ca-certificates, no gnupg"

# ---- the negative case first, while the key is absent ------------------------------------------
# A repository that installs without its key is a repository anyone can serve. Checked before the
# key goes in, because afterwards there is no way to tell the difference.
say "$BASE: refuses the repository with no key installed"
curl -fsSL https://apt.bramble.sh/bramble.sources > /etc/apt/sources.list.d/bramble.sources
if apt-get update -o Dir::Etc::sourcelist=/etc/apt/sources.list.d/bramble.sources \
	-o Dir::Etc::sourceparts=/dev/null -o APT::Get::List-Cleanup=0 2>&1 | tee /tmp/unsigned.log |
	grep -q "^Get\|^Hit"; then
	grep -qiE "no.*public key|not signed|NO_PUBKEY|Signed-By" /tmp/unsigned.log ||
		die "apt accepted the repository without the signing key"
fi
ok "apt rejects it until the key is installed"

# ---- the published snippet ---------------------------------------------------------------------
say "$BASE: the published install commands"
curl -fsSL https://apt.bramble.sh/keys.asc | tee /usr/share/keyrings/bramble-keyring.asc > /dev/null
curl -fsSL https://apt.bramble.sh/bramble.sources | tee /etc/apt/sources.list.d/bramble.sources > /dev/null
apt-get update 2>&1 | tee /tmp/update.log
grep -qiE "NO_PUBKEY|GPG error|not signed|InRelease.*not valid" /tmp/update.log &&
	die "apt update reported a signature problem"
ok "apt update accepts the signed index"

# The key must authenticate THIS repository only. Without Signed-By, a key installed for Bramble
# would be trusted for every source on the machine.
grep -q "^Signed-By: /usr/share/keyrings/bramble-keyring.asc" /etc/apt/sources.list.d/bramble.sources ||
	die "bramble.sources does not scope the key with Signed-By"
ok "the key is scoped to this repository"

say "$BASE: install"
apt-get install -y bramble 2>&1 | tail -3
ok "apt install bramble"

# ---- what actually landed ----------------------------------------------------------------------
say "$BASE: the installed package"
dpkg -s bramble | grep -q "^Status: install ok installed" || die "package is not installed"
VERSION="$(dpkg-query -W -f='${Version}' bramble)"
ok "version $VERSION"

# Debian policy wants a name AND an address; lintian flags a bare name, and it is what people see
# in `apt show`.
dpkg -s bramble | grep -E "^Maintainer:" | grep -q "<.*@.*>" ||
	die "Maintainer has no email address"
ok "$(dpkg -s bramble | grep '^Maintainer:')"

[ -x /usr/bin/bramble-desktop ] || die "no executable at /usr/bin/bramble-desktop"
ok "/usr/bin/bramble-desktop is executable"

# The open question this test exists to settle as much as anything: manifest.rs resolves the
# native-messaging proxy as a SIBLING of the running executable, and nobody had confirmed where
# Tauri's externalBin lands in a Debian package. If it is not beside the binary, the browser link
# silently does not work for anyone who installed from apt.
if [ -e /usr/bin/bramble-proxy ]; then
	ok "the browser proxy is beside the binary (/usr/bin/bramble-proxy)"
else
	found="$(find / -name 'bramble-proxy*' -type f 2>/dev/null | head -3 || true)"
	die "no proxy beside the binary; found instead: ${found:-nothing}"
fi

[ -f /usr/share/applications/Bramble.desktop ] || die "no .desktop entry"
ok "desktop entry installed"

# Every dynamic dependency resolvable on this base image is the glibc-floor claim in practice: the
# package is built on 22.04 precisely so it installs on older distributions than the builder.
if command -v ldd > /dev/null && ldd /usr/bin/bramble-desktop 2>/dev/null | grep -q "not found"; then
	ldd /usr/bin/bramble-desktop | grep "not found"
	die "unresolved shared libraries"
fi
ok "no unresolved shared libraries"

say "$BASE: removal"
apt-get remove -y -qq bramble > /dev/null
[ -e /usr/bin/bramble-desktop ] && die "binary survived removal"
ok "removes cleanly"

printf '\n\033[1;32mPASS\033[0m %s (bramble %s)\n' "$BASE" "$VERSION"
