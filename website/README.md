# Bramble website

The marketing site for [bramble.sh](https://bramble.sh): an [Astro](https://astro.build)
static site styled with [Starwind UI](https://starwind.dev) (Astro + Tailwind v4).

It uses the exact same design tokens as the browser extension and mobile apps,
imported from the shared [`@vault/theme`](../packages/theme) package, so the site
is visually identical to the product.

## Pages

- `/`: landing page (`src/pages/index.astro`)
- `/privacy`: privacy policy (`src/pages/privacy.astro`)
- `/support`: support / FAQ (`src/pages/support.astro`)
- `/docs`: help articles and search (`src/pages/docs/`, articles in `src/content/docs/`)

Pages are emitted as flat `.html` files (`build.format: "file"`). Cloudflare
Pages serves them at the clean `/privacy` and `/support` paths (the canonical
URLs) and redirects the legacy `bramble.sh/privacy.html` /
`bramble.sh/support.html` URLs to them, so both keep working.

## Version endpoints

- `/desktop/latest.json`: the desktop updater manifest, a static file the release writes.
- `/android/latest.json`: the newest Android release (version, `pub_date`, APK `url`, `sha256`,
  `size`, `release_url`), from GitHub (`functions/android/`).
- `/ios/latest.json`: the version live on the App Store (version, `pub_date`, `notes`, `url`,
  `minimum_os`), from Apple's lookup API (`functions/ios/`). A build in TestFlight or review is
  not live, so it doesn't show here.

Both functions cache upstream for an hour and serve the last good copy if the upstream fails.

## Docs (`/docs`)

Each article is one MDX file, `src/content/docs/<slug>.mdx`, served at `/docs/<slug>`. Replies
to issues link to these URLs, so don't rename a published file.

Frontmatter (schema in `src/content.config.ts`):

- `title`, `description`: the description is the line under the title and the search snippet.
- `section`: one of the ids in `src/docs-sections.ts`, which also sets the sidebar order.
- `kind`: `guide` (how to do something) or `question` (one problem, titled as the question).
- `order`: position among the section's articles of the same kind.
- `keywords`: words people search for that the text doesn't use, and the exact error messages
  the article covers.
- `updatedDate`, and `draft: true` to show an article in `pnpm dev` only (e.g. until the
  release it describes ships).

Components, usable without an import:

- `<Callout type="note|tip|warning" title="...">`
- `<PlatformTabs>` with a `<div slot="...">` per app: `mobile`, `ios`, `android`, `computer`,
  `extension`, `desktop`. The reader's choice is remembered across pages.
- `<Video src="/docs/videos/x.mp4" title="..." poster="..." caption="..." />` for self-hosted
  video. Files go in `public/docs/videos/` (Cloudflare Pages caps a file at 25 MiB).

Numbered lists render as steps. Search runs in the browser over `/docs/search.json`, built from
the articles, with [MiniSearch](https://lucaong.github.io/minisearch/) (typo tolerant); the
field weights and ranking are in `src/scripts/docs-search.ts`.

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

## Deploying (Cloudflare Pages via GitHub Actions)

`.github/workflows/deploy-website.yml` builds the static Astro site and deploys
`website/dist` to **Cloudflare Pages** with `wrangler pages deploy`, using an API
token (Cloudflare's GitHub integration is deliberately not used). It is a fully
static build, so no Cloudflare adapter is needed. `wrangler.jsonc` supplies the
project name (`bramble-website`) and the `dist` output dir.

### One-time setup

1. **Create the Pages project** (Direct Upload), authenticated locally once:

   ```sh
   pnpm --filter @vault/website exec wrangler pages project create bramble-website \
     --production-branch main
   ```

   (Or in the dashboard: Workers & Pages -> Create -> Pages -> Direct Upload.)

2. **Create the API token.** Cloudflare dashboard -> **My Profile -> API Tokens**
   -> **Create Token**. Use the **Cloudflare Pages** template, or a Custom token
   with permission **Account -> Cloudflare Pages -> Edit** scoped to your account.
   Copy it (shown only once).

3. **Find your Account ID.** Workers & Pages -> the ID in the right sidebar, or
   run `wrangler whoami`.

4. **Add the repo secrets** (GitHub -> Settings -> Secrets and variables ->
   Actions -> New repository secret):
   - `CLOUDFLARE_API_TOKEN` - the token from step 2
   - `CLOUDFLARE_ACCOUNT_ID` - the ID from step 3

5. **Custom domain.** Add `bramble.sh` under the Pages project's **Custom domains**
   tab and point its DNS at the project.

After that, every push to `main` touching `website/**` (or `packages/theme/**`)
builds and deploys; you can also run it from the Actions tab (workflow_dispatch).

### Manual deploy

```sh
CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… pnpm --filter @vault/website deploy
```

### Cut-over note

The privacy policy now lives at `/privacy` (was the root), and support at
`/support`, so update the privacy-policy and support URLs in the Chrome /
Firefox / App Store listings if any still point at `bramble.sh/` or at the old
`flythenimbus.github.io/bramble/` pages. The legacy static `website/index.html`
and `website/support.html` are no longer served (Cloudflare publishes `dist/`)
but are left in place.
