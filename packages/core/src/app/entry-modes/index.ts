import type { EntryType } from "../../hooks/useVault";
import { cardMode } from "./card";
import { loginMode } from "./login";
import { noteMode } from "./note";
import { sshKeyMode } from "./ssh-key";
import type { EntryMode } from "./types";

/** Entry-mode registry: the extension point. Add a kind to EntryType, write a descriptor, register here. */
const entryModes: Record<EntryType, EntryMode> = {
	login: loginMode,
	card: cardMode,
	note: noteMode,
	"ssh-key": sshKeyMode,
};

/** Display order for the "Add new" menu. */
export const modeList: EntryMode[] = [loginMode, cardMode, noteMode, sshKeyMode];

/** Resolve an entry mode by type string; falls back to login for unrecognised types. */
export function getEntryMode(type: string): EntryMode {
	return entryModes[type as EntryType] ?? loginMode;
}

export type { EntryMode } from "./types";
