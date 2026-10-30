import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback } from "react";
import { z } from "zod";

const SETTINGS_TABS = ["general", "security", "backups", "aliases", "sync", "about"] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

const SETTINGS_HIGHLIGHTS = ["master-password", "recovery-code"] as const;
export type SettingsHighlight = (typeof SETTINGS_HIGHLIGHTS)[number];

// The active tab lives in the route's search params so it survives navigating away
// and closing/reopening the popup (the app stashes location.href, search included).
// An unknown or absent tab falls back to General.
export const settingsSearchSchema = z.object({
	tab: z.enum(SETTINGS_TABS).default("general").catch("general"),
	// A row to draw the eye to, e.g. the master password after a recovery-code unlock.
	highlight: z.enum(SETTINGS_HIGHLIGHTS).optional().catch(undefined),
});

/** The highlighted Settings row, and a setter that swaps it without stacking history. */
export function useSettingsHighlight() {
	const { highlight } = useSearch({ from: "/_app/settings" });
	const navigate = useNavigate();
	const setHighlight = useCallback(
		(next: SettingsHighlight | undefined) =>
			navigate({
				to: "/settings",
				search: (prev) => ({ ...prev, highlight: next }),
				replace: true,
			}),
		[navigate],
	);
	return [highlight, setHighlight] as const;
}
