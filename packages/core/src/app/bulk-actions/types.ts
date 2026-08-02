import type { LucideIcon } from "lucide-react";
import type { ComponentType } from "react";
import type { Platform } from "../../context/PlatformContext";
import type { Entry } from "../../hooks/useVault";

/** What the selection toolbar hands an action's dialog. */
export interface BulkActionDialogProps {
	open: boolean;
	/** Dismissed without running. */
	onClose: () => void;
	/** The action finished; the host closes the dialog and empties the selection. */
	onDone: () => void;
	/** Ids of every selected entry, including any the current filter is hiding. */
	ids: string[];
	/** The same entries, in list order. */
	entries: Entry[];
	/**
	 * How many of them the current filter hides. An action runs on the whole selection,
	 * so a dialog for a destructive one should say when part of it is off screen.
	 */
	hiddenCount: number;
}

/**
 * Self-contained description of one bulk action. Registering a descriptor in
 * app/bulk-actions/index is the only step to add one: the toolbar's menu, the item's
 * enablement, and the dialog all read from here. Mirrors EntryMode (app/entry-modes).
 *
 * Every action goes through a dialog; there is deliberately no run-immediately path.
 * These mutate or export many secrets at once, so none of them should be one
 * unconfirmed tap.
 */
export interface BulkAction {
	id: string;
	/**
	 * Menu label. Implement as a getter over ``i18n._(msg`…`)`` so it follows a locale
	 * change, the way EntryMode.label does. Being a getter, spreading a descriptor
	 * (`{...action}`) resolves it once and freezes it to the locale active at that moment;
	 * build a fresh descriptor instead of spreading one.
	 */
	label: string;
	icon: LucideIcon;
	/** Renders the menu item in the destructive style. */
	destructive?: boolean;
	/**
	 * False hides the item outright: this platform can't do it at all (no file save,
	 * no KDBX writer). Absent means always available.
	 */
	isAvailable?(platform: Platform): boolean;
	/**
	 * False greys the item out: the platform can do it, but not to this particular
	 * selection (no logins in it, only one entry to merge). Absent means always enabled.
	 */
	isEnabled?(entries: Entry[]): boolean;
	Dialog: ComponentType<BulkActionDialogProps>;
}
