# Bramble website

The marketing site for [bramble.sh](https://bramble.sh): an [Astro](https://astro.build)
static site styled with [Starwind UI](https://starwind.dev) (Astro + Tailwind v4).

It uses the exact same design tokens as the browser extension and mobile apps,
imported from the shared [`@vault/theme`](../packages/theme) package, so the site
is visually identical to the product.

## Pages

- `/`: landing page (`src/pages/index.astro`)
- `/privacy.html`: privacy policy (`src/pages/privacy.astro`)
- `/support.html`: support / FAQ (`src/pages/support.astro`)

Pages are emitted as flat `.html` files (`build.format: "file"`) so the existing
`bramble.sh/support.html` URL keeps working.

## Commands

```sh
pnpm --filter @vault/website dev      # dev server
pnpm --filter @vault/website build    # build to website/dist
pnpm --filter @vault/website preview  # preview the build
pnpm --filter @vault/website typecheck
```

## Theming

`src/styles/starwind.css` imports `@vault/theme/theme.css` (the source of truth
for colors, radius, and dark mode) and adds a small bridge for the extra tokens
Starwind components reference (`--outline`, `--error`, `--primary-accent`, ...).
Change a color in `@vault/theme` and it changes here and in the extension at once.

Starwind components under `src/components/starwind/` are vendored source; add or
update them with `pnpm dlx starwind@latest add <name>`. They are excluded from
Biome so `starwind update` stays clean.

## Deploying (cut-over note)

`.github/workflows/pages.yml` currently publishes the raw `website/` folder,
which still serves the legacy `index.html` privacy policy at the root. To go live
with this Astro site, change that workflow to build and publish `website/dist`:

```yaml
- uses: pnpm/action-setup@v4
- uses: actions/setup-node@v4
  with: { node-version: 22, cache: pnpm }
- run: pnpm install --frozen-lockfile
- run: pnpm --filter @vault/website build
- uses: actions/upload-pages-artifact@v3
  with: { path: website/dist }
```

After the cut-over the privacy policy moves from `/` to `/privacy.html`, so update
the privacy-policy URL in the Chrome/Firefox/App Store listings (or add a redirect).
The old `website/index.html` and `website/support.html` are left in place until then.
