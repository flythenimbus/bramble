# Contributing to Bramble

Bramble is open source and contributions are welcome. It is also a password
manager, so the bar for changes is higher than for most projects. This file
describes what an acceptable contribution looks like, so you are not guessing.

## Before you start

- **Open an issue first for anything big.** New features, dependency additions,
  and changes to the vault format or crypto should be discussed before you write
  code. Bug reports and small fixes can go straight to a pull request.
- **Found a security issue? Do not open a public issue.** Report it privately via
  [GitHub Security Advisories](https://github.com/flythenimbus/bramble/security/advisories)
  or email. See [SECURITY.md](SECURITY.md).
- **Read the design docs.** [docs/](docs/README.md) holds the reasoning behind the
  crypto, unlock flows, storage, and autofill. Code comments point there instead
  of repeating it, so start there rather than reverse-engineering intent from the
  code.

## Getting set up

Pinned toolchain versions, all enforced in CI:

| Tool | Version | Source of truth |
|------|---------|-----------------|
| Node | 24 | `.github/workflows/ci.yml` |
| pnpm | 10.33.0 | `packageManager` in `package.json` |
| Rust | 1.95.0, with `rustfmt`, `clippy`, `wasm32-unknown-unknown` | `rust-toolchain.toml` |
| wasm-pack | 0.13.1 | `.github/workflows/ci.yml` |

```sh
pnpm install          # also installs the git hooks (core.hooksPath .githooks)
pnpm run wasm:build   # build the Rust crypto core to WASM; needed before the extension runs
pnpm run dev          # Chromium + Firefox extension and the website, together
```

Individual dev targets: `pnpm run dev:chrome`, `pnpm run dev:firefox`,
`pnpm run dev:website`, `pnpm run mobile:dev`. The iOS and Android apps
additionally need Xcode or Android Studio; the browser extension does not.

### The desktop app on Windows

The root `wasm:build` and `dev` scripts assume a POSIX shell (`export
RUSTFLAGS=...`), so on Windows run those through WSL or Git Bash. They only
matter for the extension and the website: the desktop app links the same Rust
crypto core natively instead of loading it as wasm, so the whole desktop loop
runs with a Windows-native toolchain from PowerShell.

Needs [Rust](https://rustup.rs) with the MSVC host target (rustup's default on
Windows) plus the Visual Studio Build Tools with the C++ workload, which
supplies `link.exe`. WebView2 ships with current Windows 10 and 11.

```powershell
pnpm install
pnpm run dev:desktop      # vite + tauri dev; opens the app
pnpm run test:desktop     # the desktop shell's cargo tests
```

`test:desktop` on Windows is not the suite you get on Linux: the named-pipe
transport, the native-messaging registry install, and the Credential Manager
store have Windows-gated tests that exist nowhere else, which is most of why
CI keeps a `windows-latest` job. A green cross-compile from another platform
exercises none of them.

An installer is one command more, but the updater makes it need a key first:
`createUpdaterArtifacts` is on, so the bundler refuses to produce an unsigned
one. Use a throwaway key, never a release key. Note the password must be
non-empty here: PowerShell drops an env var set to `''`, and the bundler then
prompts for a password that nothing can answer.

```powershell
pnpm --filter @vault/platform-desktop exec tauri signer generate -w $env:TEMP\bramble-dev.key -p "dev"
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content $env:TEMP\bramble-dev.key -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "dev"
pnpm --filter @vault/platform-desktop exec tauri build --bundles nsis
```

The installer lands in `src-tauri/target/release/bundle/nsis/`, unsigned: for a
VM, not for anyone else. Release installers are built by CI and
Authenticode-signed through SignPath; see
[docs/desktop-port.md](docs/desktop-port.md) and
[docs/release-signing.md](docs/release-signing.md). While iterating, the app's
local data (vault, logs, the browser-link manifest) lives under
`%APPDATA%\app.bramble.desktop`.

## Coding standard

**Formatting and linting is [Biome](https://biomejs.dev), configured in
`biome.json`.** Do not hand-format, and do not add a competing formatter config.

- Tabs for indentation, indent width 2, line width 100.
- `pnpm run check` fixes the whole repo in place.
- `pnpm run lint` checks without writing.
- CI runs `pnpm run ci:check` (`biome ci .`), which fails on any diff.

A `pre-commit` hook (installed by `pnpm install`) auto-fixes and re-stages the
safe Biome fixes on your staged files, then runs the workspace typecheck. Both
must pass for the commit to go through. Tests are deliberately not in the hook,
because `cargo` plus Vitest would make every commit slow; CI gates those instead.

Other conventions worth matching:

- **Comments are terse.** One line, explaining why rather than what. Anything
  longer belongs in `docs/`.
- **Match the surrounding code.** Naming, file layout, and idiom should look like
  the module you are editing.
- **No em dashes** in prose, docs, comments, or commit messages.

## Commits

Commits follow [Conventional Commits](https://www.conventionalcommits.org),
with a scope naming the area:

```
fix(autofill): revive the picker's iframe renderer under use_dynamic_url
feat(website): link the Matrix room from the header and footer
test(autofill): cover the picker's iframe renderer end to end
docs(readme): add Matrix chat badge
```

Keep the subject line in the imperative mood and lowercase after the scope.

## Tests

Changes are expected to come with tests. The crypto and vault-format paths get
extra scrutiny, and a change there without tests will be sent back.

```sh
pnpm test              # cargo test (Rust core) + Vitest across every workspace package
pnpm run wasm:test     # just the Rust core
pnpm run test:desktop  # the desktop shell (src-tauri); on Windows this also runs
                       # the named-pipe, registry, and Credential Manager tests
pnpm run test:e2e      # Playwright, against a real Chromium with the extension loaded
```

End-to-end tests do **not** run automatically on pull requests, because a fork PR
can run arbitrary code. A maintainer opts in per PR by adding the `e2e` label.
Run them locally before you push if your change touches autofill, unlock, or
sync.

Especially welcome: new real-site autofill fixtures
(`packages/platform-extension/src/fixtures/sites`) and import-format coverage
(`packages/platform-extension/src/fixtures/imports`). These are the cheapest way
to make Bramble more robust and they rarely conflict with other work.

## User-facing strings

New or changed UI copy needs its catalog updated, or it silently falls back to
English:

```sh
pnpm run i18n:extract   # pull new strings out of the source
pnpm run i18n:check     # what CI runs; fails on missing translations
```

On-page extension UI (the corner prompt, the autofill dropdown) uses `_locales`
and `browser.i18n.getMessage` rather than Lingui. See [docs/i18n.md](docs/i18n.md).

## What CI checks

Every push and pull request runs, in order: WASM build, WASM verification (a
behavioural gate over the full crypto surface), workspace typecheck, Biome,
i18n check, the full test suite, and an extension build. All of it must be green.
CodeQL runs separately over JavaScript/TypeScript, Rust, Swift, and GitHub
Actions.

You can reproduce the whole gate locally with `pnpm run typecheck && pnpm run
ci:check && pnpm test`.

## Licensing

Bramble is GPLv3. By contributing you agree that your contribution is licensed
under the same terms. See [LICENSE](LICENSE).
