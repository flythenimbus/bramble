import { z } from "zod";

const SETTINGS_TABS = ["general", "security", "backups", "sync", "about"] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

// The active tab lives in the route's search params so it survives navigating away
// and closing/reopening the popup (the app stashes location.href, search included).
// An unknown or absent tab falls back to General.
export const settingsSearchSchema = z.object({
	tab: z.enum(SETTINGS_TABS).default("general").catch("general"),
});
