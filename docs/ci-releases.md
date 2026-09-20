# Plan: releases from CI, without the YubiKey

Today every release is cut from one Mac. The builds run there, the keys are unlocked there with a
PIN and a touch, and the publish happens there. That machine is the bottleneck and the single point
of failure, and this plan removes it: **builds and signing move to GitHub Actions, and the YubiKey
stops being part of a release.**

It is a deliberate trade, and the point of writing it down is that the trade is explicit.

## What was decided

- **A release still needs one human tap.** Every environment holding a credential has a required
  reviewer. The tap moves from a YubiKey on a desk to an approval on a phone, and it keeps the
  property that matters most: repository write access alone can never sign anything.
- **The APT repository keeps signing locally, for now.** Its key was generated on the YubiKey's
  OpenPGP applet with off-card backup declined, so unlike every other secret here there is nothing
  to decrypt and move. Rotating it to a software key is its own phase, because it asks every
  existing user to install a new key once.
- **Credentials start as GitHub environment secrets.** Fetching them from an external store over
  OIDC is better custody and comes later; see [Keeping OIDC cheap](#keeping-oidc-cheap).

## What changes about trust

One sentence, because it is the whole decision:

> Today, nobody who takes over the GitHub account can sign anything. Afterwards, an approved
> workflow run is the Android keystore, the desktop updater key and the Chrome Web Store key.

The updater key is the sharp one. A signed update is code execution on every machine the app is
installed on, and it cannot be rotated: the public half is compiled into builds users already have,
so replacing it strands them on a manual re-download. That risk is accepted here, and these are the
things that keep it defensible:

| Control | Why |
|---|---|
| Required reviewer on every environment | Repository write is not enough. A run waits for a person |
| The release commit is made by an app, not by `GITHUB_TOKEN` | The ruleset on `main` requires a pull request, CodeQL and a green `CI`, which a commit that does not exist yet can never satisfy. `GITHUB_TOKEN` cannot be exempted: a ruleset evaluates it as the GitHub Actions app, and a personal repository cannot add that app to a bypass list (adding `github-actions[bot]` as a *user* was measured and does nothing). So a `bramble-release-bot` app, owned by the maintainer and installed only on this repository with **contents:write and nothing else**, is on the bypass list, and workflows mint a short-lived token per run. It may commit; it may not dispatch a workflow, read a secret, or touch anything else |
| One environment per target | A Firefox release cannot read the Android keystore |
| No third-party actions in a job holding a permanent key | Their supply chain becomes ours the moment they run beside a key |
| Every action pinned by commit, never a tag | A moved tag is a supply chain compromise with a signing key attached |
| No cache of any kind in release jobs | A cache entry is mutable state any run on this repository can write, so a restored `target/` or pnpm store puts bytes in a signed artifact that did not come from that checkout. Both defaults are on: `setup-rust-toolchain` needs `cache: false` and `setup-node` needs `package-manager-cache: false`, since it caches off `packageManager` in package.json whether or not `cache:` is set |
| Offline passphrase backups stay exactly as they are | They stop being the day-to-day path and become the recovery path |
| Post-publish verification stays | `release.yml` re-verifies every updater artifact against the public key compiled into the app |

## The credentials

| Secret | Today | Becomes | Cost if it leaks |
|---|---|---|---|
| Android keystore + 2 passwords | `android-release-keystore.age` | base64 `.jks` + 2 secrets | **Permanent.** Android pins the cert; rotating forces uninstall, losing vaults |
| Desktop updater key | `desktop-updater-key.age` | one secret | **Permanent.** Strands every install if rotated |
| CWS RSA key | `cws-signing-key.age` | PEM secret | Support ticket, up to a week |
| CWS service account | `cws-service-account.age` | JSON secret | Revoke in GCP, minutes |
| AMO key + secret | `amo-api-credentials.age` | 2 secrets | Regenerate at will |
| App Store Connect key | `asc-api-key.age` | already done | Revoke and reissue |
| Developer ID certificate | login keychain | `.p12` + password | Re-issue from Apple |
| R2 + Cloudflare purge | `.env.local` | secrets, with the APT phase | Rotate freely |
| APT repository GPG | YubiKey OpenPGP applet | **stays local for now** | Users install a new key once |

`scripts/ci-secrets.ts` performs the migration: decrypt each wrapper with one touch and push it
straight to the right environment with `gh secret set --env`, never writing plaintext to disk. One
run, one set of touches, and then the token goes in a drawer as the recovery path.

## The shape

Each target gets one workflow that builds, signs and publishes. There is no "CI builds, you sign"
split any more, because the keys are in CI too. Windows keeps its own shape inside that: SignPath
verifies where an installer came from, and its trust is configured around `sign-windows.yml`, so
that workflow is left exactly as it is, throwaway updater key and all. What moved is the other end:
`build-windows.ts --ci-start` is dispatched by the desktop workflow's first job instead of a Mac,
and `--ci-collect`, which re-signs the installer for the updater, runs in the publish job that holds
the real key.

`pnpm run release <target> <version>` stays the entry point, reduced to what it should always have
been: validate the version, dispatch, watch. Everything with an ordering invariant moves into the
workflow, where it stays in one place:

- The version bump and the release commit must exist before the build, because a runner can only
  build a commit it can fetch. This is already true for Windows today.
- The tag goes on only once every artifact exists.
- The GitHub release is published before `latest.json` is committed, because that manifest is the
  live update channel and must never name an artifact that is not there yet.
- APT publishing runs last, and its failure is not fatal to anything above it.

**The release commit is made through GitHub's API** (`createCommitOnBranch`, in
`scripts/github-commit.ts`). GitHub signs it, so it shows as verified with no signing key on the
runner, and it takes an expected head, so it lands only onto the exact commit that was built. That
also means nothing touches main until the artifact is built and signed, which is stricter than the
local route, where the bump is committed first and rewound on failure.

**Each target splits into two jobs along the line of the key.** A *build* job holds no secret, so it
may use third-party actions for the toolchain, and it hands an unsigned artifact to a *publish* job
that is the only place the key exists and runs first-party actions only. The environment's approval
gates the publish job, so what gets approved is a finished build. Android is the template:
`.github/workflows/android-release.yml`.

**A release made with the workflow's own token fires no other workflow**, so `release.yml`'s
post-publish checks never run for it. Each publish job verifies its own draft before undrafting it
instead, which is the better place for the check anyway: a bad artifact never goes public at all.

## Keeping OIDC cheap

Every credential is resolved from environment variables through one helper, the way
`scripts/asc-api-key.ts` already does: environment first, local wrapper second. Nothing in a build
or signing path ever reads a secret store directly.

That means moving to OIDC later adds one step per workflow, which fetches from the store and
exports the same variables. No build code, no signing code and no lane changes. The two permanent
keys are the ones worth moving first when that happens.

For the Android keystore there is a stronger option than fetching: `apksigner` can sign through a
PKCS#11 provider, so that key could live in a cloud HSM and never be exported at all. The updater
key cannot follow it, being Ed25519, which the major KMS offerings do not sign with.

## Phases

Each phase ends with something that can be released from CI end to end, which rules out doing one
desktop OS at a time: macOS, Linux and Windows ship as **one** release, under one `<version>-desktop`
tag with one `latest.json`, so none of them can leave the Mac until all three can.

| Phase | Delivers | Needs |
|---|---|---|
| **0** | `RELEASE_APP_ID` + `RELEASE_APP_PRIVATE_KEY` from the release app above, then `pnpm run ci:secrets`: the four environments, each with a required reviewer, and every wrapper decrypted into them. Done | One YubiKey session, the last |
| **1** | **Android**, fully from CI. Built: `android-release.yml`, `release android` | keystore + password |
| **2** | **Firefox**. Built: `firefox-release.yml`, `release firefox`, with an AMO preflight | AMO credentials |
| **3** | **Chrome**. Built: `chrome-release.yml`, `release chromium`, with a store preflight | CWS key + service account |
| **4** | **Desktop**. Built: `desktop-release.yml`, `release desktop`: Linux in the Debian container on native amd64 + arm64 runners, macOS compiled in a job holding no secrets, Windows through `sign-windows.yml` and SignPath, then one approved macOS job that bundles, codesigns, notarizes, signs every updater artifact and publishes. APT stays on a Mac (`publish:apt --release`) | updater key, Developer ID `.p12`, ASC key |
| **later** | APT key rotation, then OIDC custody | Users install a new key once |

Android leads because it is self-contained and proves every part of the pattern in one place: a
build, a signature with a permanent key, and a GitHub release published from a runner rather than
from a laptop. Desktop is last because it is the biggest, and the one where the most ordering
invariants have to move intact: bump before build, tag after artifacts, release before manifest,
APT last.

Shipping all three together is also why desktop is the one target that can be told to leave a
platform out: `release desktop <version> --skip=windows`, or several, comma-separated. It exists
because SignPath approval is outside this repository, so Windows can be unavailable for reasons
macOS and Linux are not, and a release should not have to wait on it. The cost is that `latest.json`
holds one version for every platform, so a skipped platform drops out of the manifest rather than
staying where it was, and its users' manual update checks fail until it is back. The dispatcher
warns for each skipped platform that has already shipped and then proceeds; it refuses only the case
where nothing could work, a Windows build with SignPath unconfigured. The long-term fix is
per-platform manifests through Tauri's `{{target}}` endpoint templating, which needs a release with
the new endpoint in it before it helps anyone.

Linux still gets the most out of this, just inside phase 4 rather than ahead of it: both
architectures build natively and in parallel, where today one is emulated on a Mac, and the
`container: debian:12` job keeps the glibc floor exactly while deleting the rsync-into-a-volume
dance that exists only because the build host is not Linux.

## Releasing a pair at once

`release browser <patch|minor|major>` dispatches chromium then firefox; `release mobile ...` does
ios then android. A keyword, never a version: these targets version independently, so one number
cannot mean the same release in both, and each resolves its own from `main`.

Each target runs as its own release process, so a failure stops that one and not the pair, and
every guard, prompt and editor behaves as it does when run alone. That also means **one set of
notes and one approval per target**: the saving is the typing, not the attention.

They do not watch. Watching is serial, so the first would block on its approval while the second
sat undispatched; the run URLs are printed instead.

ios goes first in the pair because it is the one route that commits from the maintainer's machine
at dispatch time, while the others commit from a job later, and every release commits with an
expected head. A collision is refused rather than mangled, but a refusal costs a build, so the
order keeps them apart. Approving one at a time does the rest. `all` deliberately does not exist:
four approvals, four editors and four racing commits, to save one command.

## What this never buys

- **Store review.** Chrome Web Store, AMO and App Store review stay human and stay slow.
- **A hands-off Debian channel**, until the APT key is rotated. That is the one remaining local
  step, and it needs two touches per publish.
- **Freedom from the approval tap**, by choice. Removing it would make repository write equivalent
  to holding every permanent key.
