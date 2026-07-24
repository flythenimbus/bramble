# Publishing Bramble on F-Droid

The official F-Droid repo's bar is FOSS + build-from-source; there is no authorship/AI policy. Bramble
passes the gate (GPL-3.0-only, no proprietary dependencies, no committed binaries, actively maintained).
The whole job is a **build recipe that compiles from source on F-Droid's Debian buildserver**, submitted
as a merge request to [fdroiddata](https://gitlab.com/fdroid/fdroiddata).

The canonical, ready-to-submit recipe is [`fdroid/app.bramble.mobile.yml`](fdroid/app.bramble.mobile.yml).

## The build recipe

The recipe lives at [`fdroid/app.bramble.mobile.yml`](fdroid/app.bramble.mobile.yml) and lands as
`metadata/app.bramble.mobile.yml` in fdroiddata. It is kept only in that file, not inlined here, so the
two copies cannot drift; read it for the current build entry, signing key and toolchain steps.

Notes on the fields:
- `subdir` is the app module; `prebuild`/`gradle` run relative to it, so `cd ../../../..` reaches the
  monorepo root for pnpm. `gradle: yes` finds `gradlew` one level up at `.../android/`.
- With no `ANDROID_KEYSTORE_FILE` in the env, `assembleRelease` yields `app-release-unsigned.apk`
  (`android/app/build.gradle:28-41`), which `output:` globs for. With reproducible builds enabled
  F-Droid compares that build against the published APK and ships ours, rather than signing its own.
- F-Droid's build allows network access (npm/cargo/gradle fetch), so the committed `pnpm-lock.yaml` +
  `--frozen-lockfile` gives a deterministic install without airgapping.

## Local validation

Two of the three build risks are verified locally (2026-07-22):

- **Clean-checkout build ✅** — a fresh checkout of tag `0.9.0-android`, then `pnpm install
  --frozen-lockfile` → `core:build` → `ffi:build:android` → `cap sync android` → `gradlew
  assembleRelease`, produced `app-release-unsigned.apk` (9.2 MB). Nothing depends on uncommitted
  working-tree state, and the frozen-lockfile install (the top Capacitor-on-F-Droid risk) works.
- **Debian toolchain bootstrap ✅** — the `sudo` block (node binary, `npm i -g pnpm@10.33.0`, rustup
  1.95.0 + Android targets, `cargo install cargo-ndk wasm-pack`) completes on `debian:bookworm` with the
  declared build deps.

The full `fdroid build` on F-Droid's **amd64** buildserver cannot be run locally on Apple Silicon: the
image is amd64-only and bundles no NDK, so it would run under emulation. It runs on F-Droid's CI when the
merge request is opened; the two checks above cover everything short of it.

## Known iteration points (expect maintainer back-and-forth)

1. **NDK version** — `27.1.12297006` must match one F-Droid ships on the buildserver. They may carry a
   different r27 patch; adjust to their available set, or request it.
2. **`UpdateCheckMode` / tag pattern** — tags are `<ver>-android` (the repo also tags `-chromium` and
   `-firefox`), while versionName is the bare `0.9.0`. The `Tags` regex may need a capture group or a
   `VercodeOperation` so F-Droid extracts `0.9.0` cleanly. Verify on the first update check.
3. **Fastlane metadata path — resolved.** fdroidserver only globs
   `<root>/fastlane/metadata/android/<locale>/` and `<root>/src/<flavor>/fastlane/metadata/android/<locale>/`
   (`update.py:1168-1169`), so the copy lives at the **repo root** `fastlane/metadata/android/`. It must
   not move back under `packages/` — a nested path leaves the listing with no name, summary or
   description. Per fdroiddata policy the metadata YAML carries no `Summary`/`Description`; both come
   from there.
4. **Scanner** — the source tree has no committed binaries, but the JNA `@aar`
   (`android/app/build.gradle:67`) bundles `libjnidispatch.so` from Maven. If the scanner flags it, add a
   `scanignore:` entry (it is FOSS with published source).
5. **`sharp`** (devDependency, prebuilt binaries) must stay off the build path. It is icon/splash
   tooling, not invoked by `core:build` or `ffi:build:android`, so it should be fine, but watch for it.

## Reproducible builds (must be enabled in the first MR)

**This is a one-way door.** Per the fdroiddata MR template: *"if you don't enable reproducible build then
the apk will be signed with our key so you can't enable it later."* For a password manager that matters:
anyone holding the GitHub-signed APK could never switch channels without uninstall/reinstall, losing the
vault, and the choice is permanent. It must be enabled in the first merge request, not added later.

Because the build must reproduce byte-for-byte, the MR has to target a tag carrying the deterministic
versionCode, so **a new Android release must be cut first** — the existing `0.9.0-android` predates that
change and cannot reproduce. Add to the build entry:

```yaml
    binary: https://github.com/flythenimbus/bramble/releases/download/%v-android/bramble_android_%v.apk
AllowedAPKSigningKeys: 464f5e913c22d580f58a4667a3adb2b720e6fcce05f7c0605cb45602fb97ece1
```

The prerequisite, a deterministic versionCode, is **done**: `android/app/build.gradle` carries a committed
`versionCode` rather than one computed from the build clock, and `pnpm run release android` bumps it to
seconds-since-2020 (`max(prev+1, now)`, so it stays monotonic and ≥ the last shipped ~206.8M) and commits
it with the tag. Rebuilding a tag therefore yields the same versionCode. This holds from the next release
onward only.

## Submitting the merge request

Requirements from the fdroiddata MR template: the fork must be **public**, the submitting branch
**unprotected** (fdroiddata rebases on merge), and CI must stay **enabled** on the fork so the build
pipeline runs. F-Droid's runners are covered by GitLab's FOSS program — if GitLab starts asking for a
phone number or credit card, submit nothing and leave a note in the MR so maintainers can trigger CI.

```sh
# after forking https://gitlab.com/fdroid/fdroiddata on GitLab:
git clone git@gitlab.com:<user>/fdroiddata.git && cd fdroiddata
git checkout -b app.bramble.mobile
cp <bramble-repo>/docs/fdroid/app.bramble.mobile.yml metadata/app.bramble.mobile.yml
fdroid lint app.bramble.mobile
git add metadata/app.bramble.mobile.yml
git commit -m "New app: Bramble"
git push -u origin app.bramble.mobile
```

Open the merge request from the fork against `fdroid/fdroiddata` `master`, titled `New app: Bramble`, and
state that the submitter is the upstream developer. The metadata passes `fdroid rewritemeta`; a local
`fdroid lint` run outside a real fdroiddata checkout falsely flags the `Security` category, which
validates against fdroiddata's `config/categories.yml`.

F-Droid's amd64 CI then runs `fdroid build` on the merge request. Check that the pipeline actually
produces an APK — a green pipeline with no APK usually means the build was disabled. Iterate with
maintainers on the iteration points above.
