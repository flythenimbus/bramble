# End-to-end tests (Playwright)

These drive a real Chromium with the built extension loaded, covering what the vitest unit
suites can't reach (the popup UI + background/offscreen + storage glue).

## Prerequisites (once)

```sh
pnpm exec playwright install chromium   # downloads the Chromium build (full build, not just the headless shell)
```

## Run

```sh
pnpm test:e2e:build     # build the extension, then run the E2E suite
# or, if dist-chromium is already up to date:
pnpm --filter @vault/platform-extension build:chromium
pnpm test:e2e
HEADED=1 pnpm test:e2e  # watch it in a real window
```

## Layout

- `fixtures.ts` - launches a persistent Chromium with the extension loaded (via `channel: "chromium"`,
  the new headless that runs MV3 service workers). `launchExtensionContext()` gives one throwaway
  profile = one independent "device".
- `helpers.ts` - UI helpers (create/lock/unlock a vault, the vault picker, open the sync panel) and
  background-storage inspection.
- `extension.spec.ts` - the extension loads and renders.
- `create-unlock.spec.ts` - create a vault, lock it, reject a wrong password, unlock it.
- `per-vault-sync.spec.ts` - two vaults have independent sync state (the per-vault-sync feature).

## Notes

- The extension must be rebuilt after source changes (`test:e2e:build` does this).
- These are serial (one worker): the persistent profile and any future local relay use fixed resources.
- A full two-device sync test (two contexts pairing over WebRTC + a local relay) is a further step;
  `per-vault-sync.spec.ts` proves the per-vault isolation via one device + seeded state, which is what
  the feature changed.
