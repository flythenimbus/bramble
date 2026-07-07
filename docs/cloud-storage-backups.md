# Cloud storage backups (planned)

Design note for the "scheduled cloud backups" feature flagged in the README:
Bramble periodically writes an encrypted backup to a storage provider the user
chooses, on a schedule the user sets. This records which providers to target and
why, so the integration surface is decided before any code.

Fast-moving facts (provider API availability, SDK maturity) are dated **July
2026** and flagged where they may shift. Re-verify before building.

## The insight that shapes everything

A Bramble backup is already client-side-encrypted ciphertext: the exported
`.bramble` blob only opens with the master password, the same as a local export
(see `vault-format.md` and `encrypted-import.md`). The storage provider never
sees plaintext, whatever provider it is.

So the provider does **not** need to be zero-knowledge or end-to-end encrypted.
"Private provider" is a nice-to-have, not a requirement. What actually matters:

- A good, stable API (ideally no fragile reverse-engineering).
- Reliability and price.
- Whether the user already has an account there.

This flips the strategy. Instead of chasing one bespoke SDK per privacy provider
(many have weak or no APIs), target a few **universal protocols** and reach
dozens of backends, self-hosted included, with one lightweight client each. No
per-provider OAuth dance and no heavy SDK, which matters for a browser extension
and a mobile app.

## Target these two adapters first

### S3-compatible

One S3 client reaches many backends. Backups are opaque objects, so a plain
PUT/GET/list/delete is all we need.

| Provider | Notes |
|---|---|
| Backblaze B2 | cheap, the de-facto backup target, clean S3 API |
| Storj | decentralized, client-side encrypted by default, ~$0.004/GB |
| Wasabi, Cloudflare R2, iDrive e2 | standard S3 |
| MinIO, Ceph, Garage | self-hosted, the "trust nobody" option |

### WebDAV

One WebDAV client reaches the self-hosted and privacy ecosystem.

| Provider | Notes |
|---|---|
| **Nextcloud / ownCloud** | self-hosted, the privacy crowd's default. Must-have. |
| Fastmail, mailbox.org, Koofr | hosted WebDAV |
| pCloud, Filen, Internxt | also expose WebDAV, so this adapter catches them too |

## Dedicated providers worth naming

Only worth a bespoke integration if users ask for it and the API is clean.

| Provider | API (July 2026) | Verdict |
|---|---|---|
| pCloud | REST + OAuth2, official JS/PHP SDKs, Swiss | cleanest OAuth story of the privacy set |
| Filen | TS/Rust/Go SDKs, REST API, plus WebDAV + S3 gateways | best "private name with a first-class API"; already reachable via WebDAV/S3 |
| Internxt | open source, CLI + WebDAV + S3 gateway | already reachable via the two adapters |
| Storj | S3-compatible + native libuplink | already covered by S3 |
| MEGA | C++ SDK + JS/Python libs, E2EE | heavier and crypto-fiddly; skip unless demanded |

## Proton Drive: not yet

Historically no public API (people used the reverse-engineered Proton-API-Bridge
that rclone rides on). As of Jan 2026 Proton shipped an **official SDK in
preview** and is migrating its own clients onto it through 2026. Caveats: it is
preview (interface still changing), personal / non-commercial use only right now,
and a crypto-model migration is slated for late 2026 / early 2027. Not
production-safe this year. Revisit around 2027.

## Recommendation and phasing

1. **S3-compatible + WebDAV adapters.** Two integrations cover Backblaze / Storj
   / Wasabi / R2 / MinIO and Nextcloud / ownCloud / Fastmail / Filen / Internxt,
   handling the privacy and self-host audience in one shot.
2. **OAuth consumer providers** (Dropbox, Google Drive, pCloud) for mainstream
   one-click users.
3. **Defer** MEGA and Proton; note Proton as "planned once its SDK stabilizes."

Because the payload is already ciphertext, the user-facing promise (the provider
never sees anything readable) holds for every backend, not only the private ones.

## References

- Proton: [SDK preview](https://proton.me/blog/proton-drive-sdk-preview), [SDK update Jan 2026](https://proton.me/blog/drive-sdk-january-2026), [ProtonDriveApps/sdk](https://github.com/ProtonDriveApps/sdk), [Proton-API-Bridge](https://github.com/henrybear327/Proton-API-Bridge)
- [pCloud API docs](https://docs.pcloud.com/)
- [Filen (GitHub org)](https://github.com/FilenCloudDienste)
- [Internxt WebDAV / rclone](https://internxt.com/webdav-rclone)
- [MEGA C++ SDK](https://github.com/meganz/sdk)
- [Backblaze B2 S3-compatible API](https://www.backblaze.com/docs/cloud-storage-s3-compatible-api)
