# The Homebrew cask for the macOS app.
#
# This is the canonical copy; the published one lives in homebrew/homebrew-cask. Keeping it here
# means `pnpm run test:brew` can check it against the live release on any machine, and a release
# that renames an artifact fails a test rather than a stranger's `brew install`.
#
# Three stanzas below are decisions rather than boilerplate. See docs/desktop-port.md.

cask "bramble" do
  version "0.2.0"
  sha256 "1154e9cbb64c135b8bccd5218a2c410896aa67996e9f754678034a45a605765e"

  url "https://github.com/flythenimbus/bramble/releases/download/#{version}-desktop/Bramble_#{version}_universal.dmg",
      verified: "github.com/flythenimbus/bramble/"
  name "Bramble"
  desc "Local-first password manager with direct device-to-device sync"
  homepage "https://bramble.sh/"

  # Not the default `:github_latest`. Every target in this repository versions independently, so
  # `/releases/latest` is whichever of the extension, Android or desktop shipped most recently —
  # usually not this one. This walks every release and matches only `-desktop` tags.
  livecheck do
    url :url
    strategy :github_releases
    regex(/^v?(\d+(?:\.\d+)+)-desktop$/i)
  end

  # The app self-updates on macOS unconditionally (`can_self_update()` in src-tauri/src/lib.rs), so
  # it will replace itself in /Applications and drift from whatever version brew recorded. This
  # tells brew the app owns its own version. Note it is the opposite call from the .deb, where the
  # updater stands down because dpkg owns the files: a cask cannot stop the updater, so it steps
  # aside instead.
  auto_updates true

  app "Bramble.app"

  # Bramble runs from the tray, so an uninstall while it is running would otherwise leave a live
  # process whose bundle has gone.
  uninstall quit: "app.bramble.desktop"

  # `zap` deletes the vault: `data_dir()` is Tauri's app_data_dir, which on macOS is the first path
  # below. That is what zap is for and it is opt-in (`brew uninstall --zap`), but it is worth
  # knowing before running it. It cannot reach the Keychain, so backup credentials survive.
  #
  # The globs cover the native-messaging manifests the app writes into other browsers' support
  # directories, one and two levels deep (Chromium and Vivaldi are one, Google/Chrome and
  # BraveSoftware/Brave-Browser are two). Left behind, they point a browser at a proxy binary that
  # no longer exists.
  zap trash: [
    "~/Library/Application Support/*/*/NativeMessagingHosts/app.bramble.desktop.json",
    "~/Library/Application Support/*/NativeMessagingHosts/app.bramble.desktop.json",
    "~/Library/Application Support/app.bramble.desktop",
    "~/Library/Caches/app.bramble.desktop",
    "~/Library/HTTPStorages/app.bramble.desktop",
    "~/Library/Preferences/app.bramble.desktop.plist",
    "~/Library/Saved Application State/app.bramble.desktop.savedState",
    "~/Library/WebKit/app.bramble.desktop",
  ]
end
