# AMO source-code submission: building Bramble for Firefox

addons.mozilla.org requires the buildable source for any add-on whose shipped code is bundled or
compiled. Bramble is Vite/Rollup-bundled and ships Rust compiled to WebAssembly, so a reviewer must
be able to rebuild the extension from source and diff it against the uploaded package.

The `pnpm run release firefox` flow attaches this source automatically (web-ext `uploadSourceCode`);
this file is the human-readable build recipe, and it ships inside that archive.

## Toolchain

- **Node.js 22 LTS**
- **pnpm 10.33.0** — pinned by `packageManager` in the root `package.json`; `corepack enable` selects it.
- **Rust 1.95.0** with the `wasm32-unknown-unknown` target — pinned by `rust-toolchain.toml`, so
  `rustup` picks the exact toolchain automatically inside the repo.
- **wasm-pack** — used by `pnpm run wasm:build` to compile the crate.

## Build

```sh
corepack enable
pnpm install --frozen-lockfile        # the lockfile pins every JS dependency
pnpm run wasm:build                    # Rust -> WASM into packages/platform-extension/public/wasm
pnpm run build:firefox                 # TARGET=firefox vite build
```

The built, unpacked extension is in **`packages/platform-extension/dist-firefox/`** — that directory
is what was uploaded to AMO. (`pnpm run bundle:firefox` runs the same `vite build` and additionally
zips `dist-firefox/`; the GitHub release attaches that `.zip`.)

## What is where

- **Rust crate:** `packages/core-rust/` (compiled by `wasm:build`).
- **TypeScript:** shared core in `packages/core/`, the extension in `packages/platform-extension/src/`,
  bundled by Vite (`packages/platform-extension/vite.config.ts`, gated on `TARGET=firefox`).
- **Manifest:** `packages/manifests/firefox/manifest.json` (copied into `dist-firefox/` at build).

## Notes for the reviewer

- No code is obfuscated; it is only minified/bundled by Vite. All original source is in this archive.
- The pinned Rust toolchain (`rust-toolchain.toml`) and the JS lockfile make the JavaScript output
  reproducible. WebAssembly binaries are not guaranteed byte-identical across machines (rustc and
  wasm-pack embed build metadata), but they are functionally identical and built only from
  `packages/core-rust/`, which is included here in full.
