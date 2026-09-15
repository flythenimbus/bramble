# Windows release checklist

What has to be exercised on a real Windows machine before a Windows installer goes out, and what
has already been verified mechanically so a human does not have to redo it.

CI runs the shell's whole `cargo test` suite on `windows-latest`, which includes the parts that
only exist on Windows: the named-pipe transport (round trip, exclusive name, per-root endpoints),
the native-messaging registry install against the real HKCU, the socket protocol suite over the
real pipe, and the Credential Manager round trip plus the uninstall purge. A green cross-compile
from another platform proves none of those, which is the whole reason the CI job exists.

Beyond CI, the following has been verified by installing a locally built (unsigned) installer on a
real machine, and is listed here as the baseline rather than something to redo every release:

- the NSIS installer runs per-user with no elevation prompt and puts the app, the proxy, and a
  working uninstaller under `%LOCALAPPDATA%\Bramble`, with a Start Menu shortcut and an
  HKCU uninstall entry;
- the app launches, renders, hides to the tray on close, and the process survives the closed
  window;
- it writes the native-messaging manifest into `%APPDATA%\app.bramble.desktop` and the matching
  HKCU `NativeMessagingHosts` keys, one per Chromium browser actually present, and none for a
  browser that is not installed;
- `bramble-desktop.exe --purge-secrets` purges real credentials from the Credential Manager;
- a silent uninstall removes the program directory and every registry key the app wrote, and
  leaves the user's data in place (the silent default of the removal prompt is No, on purpose).

## Before a release, by a human, on Windows

None of this can be automated honestly: it needs a real desktop, a real browser, and eyes.

### Installer and SmartScreen

- [ ] The **signed** installer (the SignPath artifact, not a local build) downloads and runs
      without the "unknown publisher" warning: Windows shows Bramble's publisher from the
      Authenticode certificate. An unsigned local build must still warn, which is correct.
- [ ] Install, then install again over it: an update in place must not lose the vault or force a
      logout. (The updater is the usual update path, but users do reinstall.)
- [ ] Install on a clean Windows 10 VM: WebView2 bootstrapping and the 1909-era floor.

### Vault

- [ ] Create a vault, unlock it, restart the app: it is still there and still unlocks.
- [ ] A wrong master password is refused without a hint beyond "wrong password".
- [ ] Create/rename/delete an entry, then check the files under
      `%APPDATA%\app.bramble.desktop\vaults`: only the header should be readable strings,
      everything else ciphertext. No vault key material anywhere in the Credential Manager
      (`cmdkey /list`): the store holds device identity and backup credentials only.

### Tray and quick access

- [ ] Tray icon visible, menu items (Open, Quick Access, Quit) work, Quit actually exits.
- [ ] Light and dark taskbar: the icon repaints when the Windows theme flips.
- [ ] `Ctrl+Shift+Space` opens the quick-access panel over other windows, with the acrylic
      backdrop; `Esc` hides it; a locked vault turns it into the unlock prompt.

### Autostart

- [ ] Enable "Start with system" in Settings, then check
      `reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Run"` names Bramble.
- [ ] Reboot: the app is in the tray with no window (the `--hidden` flag path), and a scheduled
      backup still ran overnight.
- [ ] Disable removes the value; so does the uninstaller.

### Browser link (the part most worth a real browser)

- [ ] Pair the extension from Settings, including the Test reconnect, in Chrome or Edge.
- [ ] Restart the browser: the link opens by itself with no re-pairing.
- [ ] Enter in the quick-access panel fills the real page the browser is on; filling is refused
      for a different tab than the panel names.
- [ ] Vivaldi specifically: it reads Chrome's `NativeMessagingHosts` key, so pairing must work
      even though `HKCU\Software\Vivaldi\NativeMessagingHosts` has nothing in it.

### Updater

- [ ] Against a release with a `windows-x86_64` entry in `latest.json`: the in-app check offers
      the update, downloads, installs, relaunches. (The committed placeholder manifest has no
      Windows entry by design; it appears with the first signed release.)
- [ ] The `.sig` published must be the one generated over the Authenticode-signed bytes. A
      signature made before SignPath signed describes a file that no longer exists and the update
      fails, which is why the order is a hard rule in build-windows.ts.

### Uninstall, both answers

- [ ] Uninstall answering **No**: vault, credentials, and `%APPDATA%` data survive a reinstall.
- [ ] Uninstall answering **Yes**: `cmdkey /list` shows no Bramble credentials left (sync identity
      and backup credentials included), `%APPDATA%\app.bramble.desktop` and
      `%LOCALAPPDATA%\app.bramble.desktop` are gone, every browser's `NativeMessagingHosts` key
      is gone, and the Run value is gone.

### Known absences, by design

Windows Hello unlock is not implemented on the desktop app on any platform (Touch ID is not
either); the browser extension does Windows Hello through WebAuthn PRF. Auto-type (SendInput) is
planned, and the quick-access panel copies to the clipboard meanwhile. Do not file these as
release blockers; do file anything that fails quietly rather than saying so.
