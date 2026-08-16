/**
 * Where each desktop download lives, and what a package-manager install looks like.
 *
 * The version is read from the update manifest rather than kept as a constant here. That file is
 * written by the release script and committed in the same push that redeploys this site
 * (docs/desktop-port.md), so the two cannot drift, and a release never needs to remember the
 * website exists.
 */
import manifest from "../public/desktop/latest.json";

const REPO = "https://github.com/flythenimbus/bramble";

export const DESKTOP_VERSION: string = manifest.version;

const TAG = `${DESKTOP_VERSION}-desktop`;

export const DESKTOP_RELEASE = `${REPO}/releases/tag/${TAG}`;

/** The updater's own artifacts, by target. Linux appears once a release is cut from Linux. */
const platforms = manifest.platforms as Record<string, { url: string } | undefined>;

export const DOWNLOADS = {
	/**
	 * Built by hand from the version, because the updater fetches the `.app.tar.gz` and never the
	 * disk image, so the manifest does not name it. `scripts/release.ts` asserts the build produced
	 * exactly this filename — a mismatch here is a 404 on the main macOS download.
	 */
	macos: `${REPO}/releases/download/${TAG}/Bramble_${DESKTOP_VERSION}_universal.dmg`,

	/**
	 * Straight out of the manifest: it is the exact file the updater fetches, so it is known to
	 * exist. Undefined before the first Linux release, and the release page is a better answer
	 * than a link that 404s.
	 */
	appimage: platforms["linux-x86_64"]?.url,
} as const;

/**
 * Three commands because they are three trust decisions: fetch the key, scope it to this one
 * repository, install. The `Signed-By` line inside `bramble.sources` is the scoping, without
 * which a key added for Bramble would authenticate packages from anywhere. See
 * docs/apt-releases.md.
 */
export const APT_INSTALL = [
	"curl -fsSL https://apt.bramble.sh/keys.asc | sudo tee /usr/share/keyrings/bramble-keyring.asc > /dev/null",
	"curl -fsSL https://apt.bramble.sh/bramble.sources | sudo tee /etc/apt/sources.list.d/bramble.sources > /dev/null",
	"sudo apt update && sudo apt install bramble",
].join("\n");

/** Built from source by the flake at the repository root. See docs/desktop-port.md. */
export const NIX_INSTALL = "nix profile install github:flythenimbus/bramble";
