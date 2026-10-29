import { useEffect, useState } from "react";
import { useCan, usePlatform } from "../../context/PlatformContext";

/**
 * Whether this device may add attachments: the `addFiles` capability, or, where that is off
 * (Firefox), a link to the desktop app, which is then the only way a file leaves this device.
 */
export function useCanAddFiles(): boolean {
	const always = useCan("addFiles");
	const { desktopLink } = usePlatform();
	const [linked, setLinked] = useState(false);
	useEffect(() => {
		if (always || !desktopLink) return;
		let live = true;
		desktopLink
			.status()
			.then((s) => {
				if (live) setLinked(s.paired && s.permitted !== false);
			})
			.catch(() => {});
		return () => {
			live = false;
		};
	}, [always, desktopLink]);
	return always || linked;
}
