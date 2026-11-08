import { useCallback, useEffect, useState } from "react";
import type { DefaultPasswordManager } from "../../adapters/shell";
import { usePlatform } from "../../context/PlatformContext";

export interface DefaultPasswordManagerSwitch {
	/** Null until the first read lands. */
	state: DefaultPasswordManager | null;
	set(bramble: boolean): void;
}

/** Making Bramble the browser's default password manager (#135). Null where the platform can't. */
export function useDefaultPasswordManager(): DefaultPasswordManagerSwitch | null {
	const { shell } = usePlatform();
	const [state, setState] = useState<DefaultPasswordManager | null>(null);

	useEffect(() => {
		if (!shell.getDefaultPasswordManager) return;
		let cancelled = false;
		void shell.getDefaultPasswordManager().then((next) => {
			if (!cancelled) setState(next);
		});
		return () => {
			cancelled = true;
		};
	}, [shell]);

	// Nothing is awaited before the call: it asks for a permission, which needs the click.
	const set = useCallback(
		(bramble: boolean) => void shell.setDefaultPasswordManager?.(bramble).then(setState, () => {}),
		[shell],
	);

	return shell.getDefaultPasswordManager && shell.setDefaultPasswordManager ? { state, set } : null;
}
