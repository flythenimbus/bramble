# File attachments: device test pass

What the automated suites cannot reach: the desktop app's link to real browsers, phones on real
networks, the native mobile file paths, and version skew against released builds. Each case says
what should happen. Note anything else, with the sync log (Settings, Sync) from both devices.

Checking a file is byte for byte: `shasum -a 256 <file>` on the original and on the copy opened
on the other device.

## Builds

The Rust core changed, so rebuild every binding before the apps:

```sh
pnpm wasm:build && pnpm wasm:build:mobile
pnpm ffi:build:ios && pnpm ffi:build:android
pnpm build && pnpm build:firefox        # dist-chromium, dist-firefox: load unpacked
```

Then the desktop app, iOS and Android builds as usual from `feat/file-attachments`.

## A. Desktop app and browsers, over the link

Desktop app paired with each browser, all in one sync group.

| # | Do | Expect |
|---|---|---|
| 1 | Attach a file in Chrome | It arrives in the desktop app and opens identical |
| 2 | Attach a file in the desktop app | It arrives in Chrome |
| 3 | Attach in the desktop app, with Firefox paired | It arrives in Firefox: the link is its only path |
| 4 | Attach in Firefox | It arrives in the desktop app |
| 5 | Edit an entry in Firefox | The edit reaches the desktop app (entry sync over the link never left Firefox before) |
| 6 | Quit the desktop app halfway through a 60 MB file, reopen | The transfer resumes and the file opens identical |
| 7 | Released desktop app with this extension, and this app with the store extension | Entry sync and autofill work as before; files just don't cross the link; no errors |

## B. Phones

| # | Do | Expect |
|---|---|---|
| 8 | Attach on the phone, desktop on the same Wi-Fi | Arrives on the desktop; and the reverse |
| 9 | Same, phone and Chrome | Arrives both ways |
| 10 | iPhone and Android phone | Arrives both ways |
| 11 | Phone on cellular, desktop at home | Note whether it arrives. This decides how soon the bucket fallback is needed |
| 12 | While a file cannot arrive | The row says "Not on this device yet", with no Open; a backup on that device waits and says why |

## C. Large files on the phones

| # | Do | Expect |
|---|---|---|
| 13 | Attach an 80 MB file on iOS, then on Android | Both seal; both open identical |
| 14 | Back up a vault with 150 MB of attachments to S3 and to WebDAV, from each phone | One ZIP lands; restored on another device, every file opens identical |
| 15 | Background the iOS app partway through that backup | Reported as interrupted, not failed; the next run completes it |

## D. Exports, and KeePass import

| # | Do | Expect |
|---|---|---|
| 16 | Settings, Backups, Export as KeePass, on a vault with attachments: in Chrome, the desktop app, iOS and Android | KeePassXC (or KeePassium) opens it; each attachment is on its entry and opens identical |
| 17 | Same, with two attachments of the same name on one entry | Both are there, as `scan.pdf` and `scan (2).pdf` |
| 18 | Phones: Export as KeePass with 150 MB of attachments and Auto-lock set to Immediately; save to Files (iOS), or to Files and to Drive (Android) | The file lands whole and opens in KeePassium or KeePassDX. On Android, note how long other actions wait while it writes |
| 19 | Desktop: Export as KeePass and cancel the save dialog; then export over an existing .kdbx | Nothing left in the app's cache `open/` folder (`~/Library/Caches/app.bramble.desktop/open/` on macOS); the second replaces the file, no `.partial` beside it |
| 20 | Export as KeePass on a phone while an attachment hasn't arrived yet | Refused, saying so; nothing is shared |
| 21 | iPhone: Send to another app, with attachments in the vault | The row says attachments aren't sent; so does the message afterwards |
| 22 | Export selection, with an entry that has attachments | The dialog says attachments aren't transferred, and how many |
| 23 | Import a KeePass database with attachments, on the desktop app, iOS and Android | The preview counts them; each lands on its entry and opens identical |
| 24 | Import the same database again | "Already in your vault": nothing is added twice |
| 25 | Lock partway through opening a large KeePass database | The import fails plainly; the unpacked attachments are gone (desktop and phones keep them under the swept `open/` folder) |

## Results: Android, Pixel 8 (2026-10-04)

Driven over the WebView's devtools socket (`e2e/android`), in a throwaway vault; files checked by
SHA-256 against the originals.

| # | Result |
|---|---|
| 9 | Pass both ways: Chrome to phone in about 11 s, phone to Chrome in about 6 s (`e2e/android/attachments-with-extension.spec.ts`) |
| 13 | Pass for 80 MB: seals and opens identical. Slow: see below |
| 14 | Pass for S3 (MinIO) and WebDAV (Nextcloud) with 150 MB of attachments: one 157 MB archive each, in about 12 and 17 minutes; the two are byte-identical, `unzip -t` clean, every blob named by its SHA-256; each restores in a fresh extension with all six attachments identical |
| 16, 17, 18 | Pass: 157 MB written in 12 s; KeePassXC extracts all six attachments identical, the second `note.txt` as `note (2).txt`; the staged copy is gone once the sheet closes. Saving to Files or Drive not tried: this phone offers neither |
| 20 | Pass: refused with the message, nothing shared or left staged |
| 22 | Pass: "3 files on these entries won't be in the export" |
| 23, 24 | Pass: three attachments land and open identical; the second import finds nothing new |
| 25 | Pass: leaving at the preview clears the unpacked file in about 2 s, and the preview now starts over saying why. Leaving while a large database is still being handed over leaves an empty folder until the app next starts |

Found along the way:

- **The Capacitor bridge moves about 0.5 MB/s on Android**, in both directions, whatever the
  slice size. Attaching 80 MB takes over two minutes, nearly all of it spooling the picked file to
  disk, and a 150 MB backup would spend about ten minutes reading and spooling before it uploads.
  Reading a file through Capacitor's local server (`convertFileSrc`) runs at about 38 MB/s, though
  its Range responses run to the end of the file. A native picker would take attaching off the
  bridge entirely.
- **Imports stop at 50 MB**, so a KeePass database with more attachments than that cannot come in,
  including a Bramble KeePass export of a vault holding them.
- Not run here: 8, 10, 11, 12, 15.

How 14 was run, to repeat it: the compose MinIO and Nextcloud behind Caddy with its own local CA
(`local_certs`, `skip_install_trust`, `auto_https disable_redirects`), `https://localhost:9443` and
`:8443`, reached through `adb reverse`. The app trusts that CA only through a debug build's
`android/app/src/debug` network security config (`<debug-overrides>` with the CA as a raw
resource), never committed and removed afterwards, so the phone's own trust store is untouched.

## Results: iOS simulator and the desktop app (2026-10-06)

The iOS 18.4 and 26.4 simulators through their web inspectors; a Debug desktop build from this
branch with `HOME` and `CFFIXED_USER_HOME` on a scratch folder (its own data, cache, link socket,
manifests and keychain), driven through a dev-only bridge that answers its native file dialogs;
Chromium with this branch's extension for the link.

| # | iOS | Desktop |
|---|---|---|
| 1, 2 | | Pass: a file each way between Chrome and the app, identical |
| Link only | | Pass: with both relays unreachable a file still crosses, in about a minute |
| 6 | | Pass: quit with 19 of 60 MB across; after reopening it resumed from 19 MB, identical |
| 12 | | Pass: "Not on this device yet" and no Open; a backup export refuses with "1 attachment isn't on this device yet" and writes nothing; the file returns by itself once Chrome is up |
| 13 | Pass: 80 MB sealed in 3 s, opens identical | 60 MB from the (stubbed) picker sealed in about a second |
| 14 | Pass: 157 MB to S3 in 16 s and WebDAV in 21 s; byte-identical archives; restored in a fresh extension, all six attachments identical | |
| 15 | Leaving mid-backup let it finish in the background; see the fix below | |
| 16-19 | Pass: 157 MB exported in 12 s, KeePassXC identical, `note (2).txt`, staged copy swept | Pass: 63 MB in 9 s, KeePassXC identical; a cancelled save leaves nothing; a second export replaces the file whole |
| 20, 22 | Pass | Pass |
| 21 | Pass on 26.4: the row says attachments aren't sent (the system sheet itself was not driven) | |
| 23-25 | Pass, after the fix below | Pass |

Fixed on the way:

- **iOS could not seal or open an attachment at all.** Capacitor gives a path that does not exist
  yet a trailing slash, so staging files and opened copies were created as folders.
- **Leaving the app during Back up now** (auto-lock taking the key before the credentials were
  read) reported "credentials were entered in another vault" and backed the target off. It is now
  recorded as interrupted.

Not a bug, found 2026-10-12:

- **An extension that synced on an older build seemed never to get the attachment records after
  it updated.** The harness relaunched the profile on the new build's path, and Chrome kept the old
  build's stored service worker, so the "updated" browser ran the new pages over the old
  background, which drops file records. With that registration cleared, as a store update does,
  the records and the file arrive. `e2e/sync/attachments-sync.spec.ts` now covers the upgrade
  from the released 1.32.0 (see e2e/README.md).

Open:

- Half of 7 seen: a `main` extension with this desktop syncs entries, carries no files and leaves
  the desktop's attachments intact.
- Not run: 3, 4, 5 (Firefox), 7 the other way round, 8, 10, 11.
