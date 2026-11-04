import { useEffect, useState } from "react";
import { usePlatform } from "../../context/PlatformContext";
import { useVaultRegistry } from "../../hooks/useVaultRegistry";

/** Whether the active vault is in a sync group, kept current where the platform reports changes. */
export function useInSyncGroup(): boolean {
	const { storage } = usePlatform();
	const { syncKey } = useVaultRegistry();
	const [inGroup, setInGroup] = useState(false);
	useEffect(() => {
		const key = syncKey("sync.group");
		let live = true;
		const read = () =>
			void storage.getMeta(key).then((g) => {
				if (live) setInGroup(g != null);
			});
		read();
		const off = storage.subscribeMeta?.(key, read);
		return () => {
			live = false;
			off?.();
		};
	}, [storage, syncKey]);
	return inGroup;
}
