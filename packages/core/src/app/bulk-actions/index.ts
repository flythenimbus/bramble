import type { Platform } from "../../context/PlatformContext";
import type { Entry } from "../../hooks/useVault";
import { archiveAction, restoreAction } from "./archive";
import { deleteAction } from "./delete";
import { exportAction } from "./export";
import { addTagAction, removeTagAction } from "./tags";
import type { BulkAction } from "./types";

/**
 * Bulk-action registry: the extension point. Write a descriptor, register it here, and
 * the selection toolbar picks it up. Nothing else needs to change.
 */
const bulkActions: BulkAction[] = [
	exportAction,
	addTagAction,
	removeTagAction,
	archiveAction,
	restoreAction,
	deleteAction,
];

/** Menu order. Destructive actions sit last, away from the pointer's resting place. */
export function availableBulkActions(platform: Platform): BulkAction[] {
	return bulkActions.filter((action) => action.isAvailable?.(platform) ?? true);
}

/** Whether an action can act on this particular selection. */
export function isBulkActionEnabled(action: BulkAction, entries: Entry[]): boolean {
	return entries.length > 0 && (action.isEnabled?.(entries) ?? true);
}

export type { BulkAction, BulkActionDialogProps } from "./types";
