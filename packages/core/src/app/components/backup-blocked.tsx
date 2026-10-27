import { plural, t } from "@lingui/core/macro";
import type { BackupBlocked } from "../../backup/archive";

// .tsx, not .ts: the Lingui macro transform only covers .tsx, and a macro in a .ts file
// silently interpolates without ever being extracted or translated.

/** Why a vault was not backed up, for a status line or a toast. Never partial: a backup that
 * cannot hold the whole vault is not made, so this is what the user sees instead. */
export function blockedMessage(blocked: BackupBlocked): string {
	return blocked.reason === "missing"
		? plural(blocked.count, {
				one: "Not backed up: # attachment isn't on this device yet. Backups resume once it arrives.",
				other:
					"Not backed up: # attachments aren't on this device yet. Backups resume once they arrive.",
			})
		: t`Not backed up: this vault's attachments can't be listed while it's locked. Unlock it once to resume.`;
}
