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

## Deploying (Cloudflare Pages)

The site deploys to **Cloudflare Pages** (the old GitHub Actions Pages workflow
was removed). It is a fully static Astro build, so no Cloudflare adapter is
needed. `wrangler.jsonc` names the project (`bramble-website`) and points at the
`dist` output.

### One-time setup (Cloudflare dashboard)

Create the Pages project once, connecting this GitHub repo, with these build
settings (it is a pnpm monorepo, so build from the repo root):

| Setting | Value |
| --- | --- |
| Production branch | `main` |
| Root directory | *(repo root, leave empty)* |
| Build command | `pnpm --filter @vault/website build` |
| Build output directory | `website/dist` |
| Environment variable | `NODE_VERSION` = `22` (Astro 7 needs ≥ 22.12) |

Cloudflare auto-detects pnpm from `pnpm-lock.yaml`. Add the custom domain
`bramble.sh` under the project's **Custom domains** tab (point the DNS record at
the Pages project). After that, every push to `main` builds and deploys.

### Manual deploy

Authenticate wrangler once (`wrangler login` or a `CLOUDFLARE_API_TOKEN`), then:

```sh
pnpm --filter @vault/website deploy   # astro build && wrangler pages deploy
```

### Cut-over note

The privacy policy now lives at `/privacy.html` instead of the root, so update
the privacy-policy URL in the Chrome / Firefox / App Store listings if any point
at `bramble.sh/`. The legacy static `website/index.html` and `website/support.html`
are no longer served (Cloudflare publishes `dist/`) but are left in place.
