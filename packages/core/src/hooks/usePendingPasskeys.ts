import { useLingui } from "@lingui/react/macro";
import { KeyRound } from "lucide-react";
import { useEffect, useRef } from "react";
import { useToast } from "../app/components/ui/toast";
import { usePlatform } from "../context/PlatformContext";
import { planPasskeyPlacement } from "../vault/passkey";
import { useVault } from "./useVault";

/**
 * Mobile only: once the vault is unlocked, drain any passkeys the native credential provider
 * minted during a sign-in registration (the sandboxed extension can't write the vault) and
 * persist them - attaching to the matching login or creating one (planPasskeyPlacement) - then
 * a confirmation toast. No-op where shell.consumePendingPasskeys is absent (extension/desktop).
 * See docs/passkey-provider.md.
 */
export function usePendingPasskeys(): void {
	const { shell } = usePlatform();
	const { entries, addEntry, updateEntry, isLocked, ready } = useVault();
	const { show } = useToast();
	const { t } = useLingui();
	// Read the latest vault + helpers inside the async drain without re-firing the effect on
	// every entries change (it should fire on unlock, not on its own writes).
	const latest = useRef({ entries, addEntry, updateEntry, show, t });
	latest.current = { entries, addEntry, updateEntry, show, t };
	const draining = useRef(false);

	useEffect(() => {
		const drain = shell.consumePendingPasskeys;
		if (!drain || !ready || isLocked || draining.current) return;
		draining.current = true;
		void (async () => {
			try {
				const pending = await drain();
				for (const pk of pending) {
					const { entries, addEntry, updateEntry, show, t } = latest.current;
					// Rare: several pending passkeys for the same site land against one snapshot,
					// so a second could create a duplicate login. Acceptable for a pre-launch batch.
					const placement = planPasskeyPlacement(entries, pk.rpId, pk.rpName, pk);
					let loginName: string;
					if (placement.kind === "create") {
						await addEntry(placement.data);
						loginName = placement.data.name;
					} else {
						const entry = entries.find((e) => e.id === placement.entryId);
						if (entry?.type !== "login") continue;
						const { id: _id, ...data } = entry;
						await updateEntry(placement.entryId, { ...data, passkeys: placement.passkeys });
						loginName = entry.name;
					}
					show({
						message:
							placement.kind === "create"
								? t`Passkey saved as ${loginName}`
								: t`Passkey added to ${loginName}`,
						variant: "success",
						icon: KeyRound,
					});
				}
			} finally {
				draining.current = false;
			}
		})();
	}, [shell, ready, isLocked]);
}
