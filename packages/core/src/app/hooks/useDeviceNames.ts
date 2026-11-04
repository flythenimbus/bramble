import { useCallback } from "react";
import { useSyncedSettings } from "../../hooks/synced-settings";
import type { RosterEntry } from "../../sync";

/** The synced setting holding the name given to one device, by its roster id. */
export const deviceNameKey = (deviceId: string): string => `device.name:${deviceId}`;

/** Enough of a roster entry to name it. */
export type DeviceRef = Pick<RosterEntry, "id" | "label">;

/**
 * Names given to the devices in the sync group, the same on every one of them.
 *
 * Each device stamps a default ("Firefox on Mac") into its own roster entry, which only it can
 * re-sign. A name given here lives in the vault's encrypted synced settings instead, so any device
 * can name any device and the name reaches the others with the next sync. A given name wins over
 * the default; clearing it brings the default back. See docs/synced-settings.md.
 */
export function useDeviceNames(): {
	/** The name to show, or "" when the device has none at all. */
	nameOf(device: DeviceRef): string;
	/** Name a device on every device; blank clears the name. */
	rename(deviceId: string, name: string): Promise<void>;
	/** Whether the vault is open, so a rename can be saved. */
	canRename: boolean;
} {
	const { settings, ready, set } = useSyncedSettings();
	const nameOf = useCallback(
		(device: DeviceRef) => {
			// Validated on read: another build, or another device, wrote it.
			const value = settings?.[deviceNameKey(device.id)]?.value;
			return typeof value === "string" && value.trim() ? value.trim() : device.label;
		},
		[settings],
	);
	const rename = useCallback(
		(deviceId: string, name: string) => set(deviceNameKey(deviceId), name.trim() || null),
		[set],
	);
	return { nameOf, rename, canRename: ready };
}
