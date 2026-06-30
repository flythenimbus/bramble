import { useLingui } from "@lingui/react/macro";
import { KeyRound } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";
import { useToast } from "../app/components/ui/toast";
import { usePlatform } from "../context/PlatformContext";
import { planPasskeyPlacement } from "../vault/passkey";
import { useVault } from "./useVault";

/**
 * Mobile only: drain any passkeys the native credential provider minted during a sign-in
 * registration (the sandboxed AutoFill extension can't write the vault) and persist them -
 * attaching to the matching login or creating one (planPasskeyPlacement) - then a confirmation
 * toast. Runs on unlock AND on app foreground, since creating a passkey in Safari and returning
 * to an already-unlocked app has no lock/unlock transition to ride. No-op where
 * shell.consumePendingPasskeys is absent (extension/desktop). See docs/passkey-provider.md.
 */
export function usePendingPasskeys(): void {
	const { shell } = usePlatform();
	const { entries, addEntry, updateEntry, isLocked, ready } = useVault();
	const { show } = useToast();
	const { t } = useLingui();
	// Read the latest vault + helpers inside the async drain without re-firing on every entries
	// change, and so the foreground listener always sees current lock/ready state.
	const latest = useRef({ entries, addEntry, updateEntry, show, t, isLocked, ready });
	latest.current = { entries, addEntry, updateEntry, show, t, isLocked, ready };
	const draining = useRef(false);

	const drainNow = useCallback(async () => {
		const drain = shell.consumePendingPasskeys;
		const { ready, isLocked } = latest.current;
		if (!drain || !ready || isLocked || draining.current) return;
		draining.current = true;
		try {
			const pending = await drain();
			for (const pk of pending) {
				const { entries, addEntry, updateEntry, show, t } = latest.current;
				try {
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
				} catch {
					// One bad entry shouldn't drop the rest of the drained batch.
				}
			}
		} finally {
			draining.current = false;
		}
	}, [shell]);

	// On unlock + mount. ready/isLocked are change triggers (drainNow reads them from the ref),
	// so the drain re-runs the moment the vault unlocks.
	// biome-ignore lint/correctness/useExhaustiveDependencies: ready/isLocked are the unlock trigger
	useEffect(() => {
		void drainNow();
	}, [drainNow, ready, isLocked]);

	// On app foreground too: returning from a Safari passkey-create to an already-unlocked
	// vault has no lock/unlock change, so visibility is the only signal we'd otherwise miss.
	useEffect(() => {
		const onVisible = () => {
			if (document.visibilityState === "visible") void drainNow();
		};
		document.addEventListener("visibilitychange", onVisible);
		return () => document.removeEventListener("visibilitychange", onVisible);
	}, [drainNow]);
}
