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
| One environment per target | A Firefox release cannot read the Android keystore |
| No third-party actions in a job holding a permanent key | Their supply chain becomes ours the moment they run beside a key |
| Every action pinned by commit, never a tag | A moved tag is a supply chain compromise with a signing key attached |
| No build cache in release jobs | A restored `target/` puts objects in a signed binary that did not come from that checkout. `sign-windows.yml` already reasons this way for SignPath |
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
split any more, because the keys are in CI too. That collapses rather than generalises the Windows
pattern: `build-windows.ts --ci-collect` exists only to bring an installer home for its updater
signature, and once the updater key is in the same job, both signatures happen in one place. The
throwaway-key trick in `sign-windows.yml` goes away with it.

`pnpm run release <target> <version>` stays the entry point, reduced to what it should always have
been: validate the version, dispatch, watch. Everything with an ordering invariant moves into the
workflow, where it stays in one place:

- The version bump and the release commit must exist before the build, because a runner can only
  build a commit it can fetch. This is already true for Windows today.
- The tag goes on only once every artifact exists.
- The GitHub release is published before `latest.json` is committed, because that manifest is the
  live update channel and must never name an artifact that is not there yet.
- APT publishing runs last, and its failure is not fatal to anything above it.

**Open question: who makes the release commit.** Commits made through the GitHub API are signed
with GitHub's own key and show as verified, which is the cleanest way for a workflow to make the
bump commit without a signing key of its own. The alternative is committing as a bot with no
signature, which weakens `git log` as a record of what shipped.

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

| Phase | Delivers | Needs |
|---|---|---|
| **0** | `scripts/ci-secrets.ts`, the environments, the dispatcher shape in `release.ts` | The migration touch |
| **1** | **Linux** on native `ubuntu-24.04` + `ubuntu-24.04-arm`, job `container: debian:12` | updater key |
| **2** | **Android** | keystore + passwords |
| **3** | **macOS** on `macos-26` | Developer ID `.p12`, updater key |
| **4** | **Windows**, absorbing `--ci-collect` | updater key |
| **5** | **Firefox** | AMO credentials |
| **6** | **Chrome** | CWS key + service account |
| **later** | APT key rotation, then OIDC custody | Users install a new key once |

Linux is first because it is the only one that gets faster rather than merely relocated: both
architectures build natively and in parallel, where today one of them is emulated on a Mac. The
`container: debian:12` job preserves the glibc floor exactly and deletes the rsync-into-a-volume
dance that exists only because the build host is not Linux.

## What this never buys

- **Store review.** Chrome Web Store, AMO and App Store review stay human and stay slow.
- **A hands-off Debian channel**, until the APT key is rotated. That is the one remaining local
  step, and it needs two touches per publish.
- **Freedom from the approval tap**, by choice. Removing it would make repository write equivalent
  to holding every permanent key.
