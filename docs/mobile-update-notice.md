# Mobile update notice

The desktop app updates itself (`shell.updates`, see [desktop-port.md](desktop-port.md)). The mobile
apps cannot, so they only say a newer version exists and point at it. Code:
`packages/core/src/app/app-update.ts`, `app/hooks/useAppUpdate.ts`, `app/components/UpdateCard.tsx`.

## What it does

- Once a day at most, while the vault list is open, the app fetches
  `https://bramble.sh/ios/latest.json` or `https://bramble.sh/android/latest.json` (Pages Functions,
  see `website/README.md`). The request has no cookies and carries nothing from the vault or device.
- If that version is newer than the installed one, the vault list shows a card, ahead of the review
  and default-manager cards, since an update may carry a security fix.
- **iOS:** "Update now" opens the App Store listing. The URL is a constant in the app, not read from
  the manifest. The iOS endpoint reports what Apple says is live, so a build still in review or
  TestFlight never triggers the card, and a TestFlight build ahead of the store reads as current.
- **Android:** "Update now" opens the signed APK from the GitHub release in the browser, which
  downloads it; tapping the download installs it over the current app. Android refuses an APK whose
  signing certificate differs from the installed one, so a substituted file cannot replace Bramble.
  The app still accepts only a `.apk` under this repo's `releases/download/` URL.
- Closing the card records that version; the next newer one shows it again.
- Settings → About → Updates has "Check for updates when Bramble opens". It is on by default, like
  the desktop's, because a fix that reaches nobody fixes nothing. Off means no request at all and no
  card.

## Why not install in the app on Android

Downloading and installing in place needs `REQUEST_INSTALL_PACKAGES`, a permission that lets an app
install other apps. A password manager holding it is a worse trust story than one tap through the
browser, which already has the user's "install unknown apps" grant from the first install.

## Not handled yet

- Installs that something else keeps current (F-Droid once listed, Obtainium) still see the card.
  Detecting them needs the installer package name from native code
  (`PackageManager.getInstallSourceInfo`).
- The check runs when the vault list mounts, so a locked app never checks.
