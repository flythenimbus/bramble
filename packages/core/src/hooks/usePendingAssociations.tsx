import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Link2 } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";
import { useToast } from "../app/components/ui/toast";
import { usePlatform } from "../context/PlatformContext";
import { planAssociationUpdates } from "../vault/association";
import { useVault } from "./useVault";
import { useVaultRegistry } from "./useVaultRegistry";

export function usePendingAssociations(): void {
	const { shell } = usePlatform();
	const { entries, updateEntry, isLocked, ready } = useVault();
	const { activeId } = useVaultRegistry();
	const { show } = useToast();
	const latest = useRef({ entries, updateEntry, activeId, show, isLocked, ready });
	latest.current = { entries, updateEntry, activeId, show, isLocked, ready };
	const draining = useRef(false);

	const drainNow = useCallback(async () => {
		const drain = shell.consumePendingAssociations;
		const { ready, isLocked } = latest.current;
		if (!drain || !ready || isLocked || draining.current) return;
		draining.current = true;
		try {
			const { entries, updateEntry, activeId, show } = latest.current;
			const updates = planAssociationUpdates(entries, activeId, await drain());
			for (const u of updates) {
				try {
					await updateEntry(u.entryId, u.data);
					show({
						message: i18n._(msg`Saved ${u.added.join(", ")} to ${u.entryName}`),
						variant: "success",
						icon: Link2,
					});
				} catch {
					// One failed update drops just its association.
				}
			}
		} finally {
			draining.current = false;
		}
	}, [shell]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: ready/isLocked are the unlock trigger
	useEffect(() => {
		void drainNow();
	}, [drainNow, ready, isLocked]);

	useEffect(() => {
		const onVisible = () => {
			if (document.visibilityState === "visible") void drainNow();
		};
		document.addEventListener("visibilitychange", onVisible);
		return () => document.removeEventListener("visibilitychange", onVisible);
	}, [drainNow]);
}
