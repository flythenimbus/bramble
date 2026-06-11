# Bramble website

A dependency-free static site whose only real job is to host the **privacy
policy** that the Chrome Web Store requires. No build step — just three files:

```
website/
  index.html     landing page
  privacy.html   the privacy policy (this is the URL the Web Store needs)
  styles.css     shared styles
```

## Before publishing

Two placeholders to fill in:

1. **Contact email** — replace `[CONTACT EMAIL]` in `privacy.html` (appears twice:
   the `mailto:` link and its text).
2. **Store link** *(optional)* — add the Chrome Web Store listing URL to the
   `index.html` button once the extension is published (marked with a `TODO`).

## Deploy (pick one)

All of these serve the folder as-is.

**GitHub Pages** — Settings → Pages → Build from a branch. To serve from this
subfolder, either move these files to `/docs` and select `/docs`, or push the
`website/` contents to a `gh-pages` branch root.

**Netlify / Cloudflare Pages** — drag-and-drop the `website/` folder, or point a
new project at this repo with **publish directory = `website`** and **no build
command**.

**Any static host / S3 / your own server** — upload the three files.

## The URL to give the Web Store

After deploying, the privacy-policy URL is:

```
https://<your-domain>/privacy.html
```

Paste that into the Chrome Web Store listing under
**Privacy practices → Privacy policy URL**.

## Keeping it accurate

The policy states Bramble collects nothing and makes no network requests. That
matches the code today (no analytics/telemetry deps; the only `fetch()` is on a
local `data:` URL for QR decoding). If that ever changes — adding sync, crash
reporting, etc. — update `privacy.html` and the effective date to match.
