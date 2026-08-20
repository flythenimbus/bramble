#!/usr/bin/env bash
# Check the Homebrew cask against the live release.
#
# Run by scripts/test-brew-cask.ts, natively on macOS and in the homebrew/brew container anywhere
# else. Runnable by hand: $1 is the released version, $2 the cask (default /cask/bramble.rb, where
# the container mounts it).
#
# Homebrew refuses to *install* a cask on Linux, and that is the only part of this that needs a
# Mac. Everything before it runs: style, audit, livecheck against the real GitHub API, and a real
# download whose checksum is verified against the real bytes. So the cask can be kept honest from
# any machine, and the Mac is needed only for the install/zap round trip.
#
# What this is actually guarding:
#
# - **The livecheck strategy.** Every target in this repository versions independently, so
#   `/releases/latest` is usually the extension or Android, not the desktop app. A cask using the
#   default strategy would offer a version whose .dmg does not exist. Asserting `latest == current`
#   catches that, because a strategy reading the wrong tags reports a wrong version here.
# - **The URL surviving a release.** The cask builds its download URL out of the version. A
#   release that renames the disk image breaks it, and nothing else would notice until someone
#   installed it.
# - **The cask keeping up with releases.** The expected version comes from the update manifest, so
#   a shipped release with a stale cask fails here.
# - **The audit being the one a submission gets.** Only if the ruleset is current and the checks
#   all run, neither of which is free off macOS; see the two blocks below.

set -euo pipefail

EXPECTED="${1:?the released version, from website/public/desktop/latest.json}"
CASK="${2:-/cask/bramble.rb}"
FULL=flythenimbus/bramble/bramble

say() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
ok() { printf '  ok: %s\n' "$1"; }
die() {
	printf '  FAIL: %s\n' "$1" >&2
	exit 1
}

MAC=false
[ "$(uname -s)" = "Darwin" ] && MAC=true

say "homebrew"
if $MAC; then
	# Whatever the maintainer has, and deliberately left alone: a repo test has no business
	# upgrading someone's Homebrew.
	ok "$(brew --version | head -1)"
else
	# Homebrew inside the image is whatever homebrew/brew:latest was built with, and Docker Hub
	# stopped publishing that image at 4.6.20 in November 2025. Auditing against a ruleset that old
	# is worse than not auditing: it passed a cask carrying a `verified:` parameter that brew 6
	# rejects, which is exactly the failure this test exists to catch before a stranger does. The
	# image ships Homebrew as a git checkout, so this is a fast-forward onto the version a Mac has.
	brew update > /tmp/update.log 2>&1 || {
		cat /tmp/update.log >&2
		die "brew update failed"
	}
	ok "$(brew --version | head -1), fast-forwarded from the image's"
fi

# audit wants a tap, and a tap is a git repository. Removed on the way out, whatever happens.
say "a throwaway tap"
TAP="$(brew --repository)/Library/Taps/flythenimbus/homebrew-bramble"
# Guarded because what follows is an rm -rf, and on macOS this is a real Homebrew.
case "$TAP" in */Library/Taps/*) ;; *) die "unexpected tap path: $TAP" ;; esac
trap 'rm -rf "$TAP"' EXIT
mkdir -p "$TAP/Casks"
cp "$CASK" "$TAP/Casks/bramble.rb"
git -C "$TAP" init -q .
git -C "$TAP" add -A
git -C "$TAP" -c user.email=test@bramble.sh -c user.name=test commit -qm "cask under test"
ok "$TAP"

# Both of these exit non-zero on an offence and are noisy on success (developer-mode warnings, a
# JSON API download), so the output is shown only when they fail.
say "brew style"
brew style "$TAP/Casks/bramble.rb" > /tmp/style.log 2>&1 || {
	cat /tmp/style.log >&2
	die "style offenses"
}
ok "no offenses"

# --new is the stricter set homebrew-cask applies to a submission: token naming, the desc, the
# verified stanza, a reachable homepage. Their CI runs the macOS-only checks on top, so a pass
# here is necessary and not sufficient.
say "brew audit --new"
# Four of its checks mount the disk image to look inside the .app -- signing, artifact_case,
# rosetta and min_os -- and hdiutil exists only on macOS. Off it they do not fail, they raise, and
# the audit stops at the first one, so skipping them explicitly is the difference between a run
# that reports its coverage and one that dies on `hdiutil: No such file`. On a Mac nothing is
# skipped, which is why this prefers to run there.
EXCEPT=""
$MAC || EXCEPT="--except=signing,artifact_case,rosetta,min_os"
# shellcheck disable=SC2086
brew audit --new --cask $EXCEPT "$FULL" > /tmp/audit.log 2>&1 || {
	cat /tmp/audit.log >&2
	die "audit offenses"
}
if $MAC; then
	ok "no offenses"
else
	ok "no offenses (signing, artifact_case, rosetta and min_os need macOS; skipped)"
fi

say "what the cask declares"
INFO="$(brew info --cask --json=v2 "$FULL" 2>/dev/null)"
[ -n "$INFO" ] || die "brew info produced nothing"
read -r TOKEN VERSION SHA AUTO URL <<<"$(echo "$INFO" | jq -r '.casks[0] | "\(.token) \(.version) \(.sha256) \(.auto_updates) \(.url)"')"

[ "$TOKEN" = "bramble" ] || die "token is $TOKEN"
ok "token: $TOKEN"

# The app self-updates on macOS, so without this brew fights it on every release.
[ "$AUTO" = "true" ] || die "auto_updates is $AUTO; brew would try to manage a self-updating app"
ok "auto_updates: true"

echo "$INFO" | jq -e '.casks[0].artifacts[] | select(.app) | .app[0] == "Bramble.app"' > /dev/null ||
	die "no Bramble.app artifact"
ok "installs Bramble.app"

echo "$INFO" | jq -e '.casks[0].artifacts[] | select(.zap)' > /dev/null || die "no zap stanza"
ok "has a zap stanza"

say "the cask points at the current release"
[ "$VERSION" = "$EXPECTED" ] ||
	die "cask is $VERSION but the update manifest says $EXPECTED; bump packages/platform-desktop/homebrew/bramble.rb"
ok "$VERSION matches the update manifest"

# The published SHA256SUMS is the release's own record of what it shipped. Comparing against it
# catches a cask edited to a checksum that belongs to nothing, which `brew fetch` alone would
# report only as a mismatch against whatever the URL happens to serve.
say "the checksum matches the release's own SHA256SUMS"
SUMS="https://github.com/flythenimbus/bramble/releases/download/${VERSION}-desktop/SHA256SUMS"
DMG="$(basename "$URL")"
PUBLISHED="$(curl -fsSL "$SUMS" | awk -v f="$DMG" '$2 == f { print $1 }')"
[ -n "$PUBLISHED" ] || die "$DMG is not in $SUMS; did the release rename the disk image?"
[ "$PUBLISHED" = "$SHA" ] || die "cask has $SHA, the release published $PUBLISHED"
ok "$DMG"

# The whole point of the custom strategy. `latest` is what the regex found across every release in
# the repository, so a strategy reading the wrong tags shows up as a version that is not ours.
say "brew livecheck"
LATEST="$(brew livecheck --cask --json --quiet "$FULL" 2>/dev/null | jq -r '.[0].version.latest')"
[ "$LATEST" = "$VERSION" ] ||
	die "livecheck found $LATEST, not $VERSION — the -desktop regex is matching another target's tags"
ok "found $LATEST, and nothing from the other targets"

# Downloads the real disk image and verifies it, which is the last thing that can be checked
# without a Mac: past here it would have to mount it.
say "brew fetch"
brew fetch --cask --force "$FULL" > /dev/null 2>&1 || die "download or checksum verification failed"
ok "downloaded and verified"

printf '\n\033[1;32mPASS\033[0m bramble %s\n' "$VERSION"
if $MAC; then
	printf 'Still to do by hand: brew install --cask, launching it past Gatekeeper, uninstall --zap.\n'
else
	printf 'Still needs a Mac: the four skipped audit checks, brew install --cask, launching it past\n'
	printf 'Gatekeeper, and uninstall --zap.\n'
fi
