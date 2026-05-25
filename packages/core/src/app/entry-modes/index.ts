import type { EntryType } from "../../hooks/useVault";
import { cardMode } from "./card";
import { loginMode } from "./login";
import { noteMode } from "./note";
import { sshKeyMode } from "./ssh-key";
import type { EntryMode } from "./types";

export const entryModes: Record<EntryType, EntryMode> = {
	login: loginMode,
	card: cardMode,
	note: noteMode,
	"ssh-key": sshKeyMode,
};

export const modeList: EntryMode[] = [loginMode, cardMode, noteMode, sshKeyMode];

export function getEntryMode(type: string): EntryMode {
	return entryModes[type as EntryType] ?? loginMode;
}

export type { EntryMode } from "./types";
