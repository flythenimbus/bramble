// Fixes the "Simulator window opens off-screen / isn't visible" problem, which
// happens when Simulator has saved window positions tied to a display that is no
// longer connected (e.g. an external monitor). Quits Simulator, backs up and
// clears the per-device window geometry, points it at the newest iPhone, and
// reopens it. Your other Simulator settings are left untouched.
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const sh = (cmd) => execSync(cmd, { encoding: "utf8" });
const quiet = (cmd) => {
	try {
		return sh(cmd);
	} catch {
		return "";
	}
};

console.log("• Quitting Simulator");
quiet(`osascript -e 'quit app "Simulator"'`);
quiet("sleep 2");

const backup = quiet("defaults read com.apple.iphonesimulator DevicePreferences");
if (backup) {
	writeFileSync("/tmp/sim-deviceprefs-backup.txt", backup);
	console.log("• Backed up window prefs to /tmp/sim-deviceprefs-backup.txt");
}

console.log("• Clearing off-screen window geometry (DevicePreferences)");
quiet("defaults delete com.apple.iphonesimulator DevicePreferences");

const udid = quiet("node scripts/pick-ios-target.mjs").trim();
if (udid) {
	quiet(`defaults write com.apple.iphonesimulator CurrentDeviceUDID -string "${udid}"`);
	console.log(`• Focused newest iPhone (${udid})`);
}

console.log("• Reopening Simulator");
quiet("open -a Simulator");
console.log("Done. Re-run `pnpm dev:ios` if the app isn't running.");
