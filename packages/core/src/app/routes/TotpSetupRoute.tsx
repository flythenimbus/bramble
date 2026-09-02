import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { isLogin, useVault } from "../../hooks/useVault";
import { classifyScannedQr, parseTotp } from "../../util/totp";
import { setPendingCreateEntry } from "../pending-create-entry";
import { setTotpForEntry, takePendingTotp } from "../pending-totp";
import { TotpSetup, TotpSetupFailure, type TotpTarget } from "../screens/TotpSetup/TotpSetup";
import { toListItem } from "../screens/VaultHome/list-item";
import { DEFAULT_SEARCH, filterAndSortEntries } from "../screens/VaultHome/vault-search";

/**
 * Destination picker for an authenticator key the OS handed over. Takes the parked key on
 * mount, so backing out discards it rather than leaving a seed in memory. See
 * docs/totp-uri-handler.md.
 */
export function TotpSetupRoute() {
	const navigate = useNavigate();
	const { entries } = useVault();
	// Consumed once, at mount: this route is the only reader, and a key that survived a
	// second visit would be a key the user already declined to place.
	const [uri] = useState(() => takePendingTotp());
	const [query, setQuery] = useState("");

	const scan = useMemo(() => classifyScannedQr(uri), [uri]);
	const parsed = useMemo(() => (scan.uri ? parseTotp(scan.uri) : null), [scan.uri]);

	// Nothing parked (a direct navigation, or a remount after the key was taken) is not an
	// error worth a screen: there is simply nothing to place.
	useEffect(() => {
		if (uri === null) void navigate({ to: "/vault", replace: true });
	}, [uri, navigate]);

	// Only logins can hold an authenticator key, and only live ones: offering an archived
	// entry would quietly un-retire it. Reuses the vault list's own search and ordering so
	// a login is found here exactly the way it is found there.
	const targets = useMemo<TotpTarget[]>(() => {
		const totpById = new Map(
			entries.filter(isLogin).map((e) => [e.id, Boolean(e.totp?.trim())] as const),
		);
		const items = entries.map((e) => toListItem(e, false));
		return filterAndSortEntries(items, { ...DEFAULT_SEARCH, q: query, type: "login" }).map(
			(item) => ({
				id: item.id,
				name: item.name,
				secondary: item.secondary,
				icon: item.icon,
				initials: item.initials,
				hasTotp: totpById.get(item.id) ?? false,
			}),
		);
	}, [entries, query]);

	if (uri === null) return null;

	if (!scan.uri) {
		return (
			<TotpSetupFailure
				failure={scan.failure ?? "not-totp"}
				vendor={scan.vendor}
				onDismiss={() => void navigate({ to: "/vault" })}
			/>
		);
	}

	const key = scan.uri;

	const createNew = () => {
		setPendingCreateEntry({
			type: "login",
			name: parsed?.issuer || parsed?.account || "",
			urls: [],
			username: parsed?.account ?? "",
			password: "",
			totp: key,
		});
		void navigate({ to: "/vault/new/$type", params: { type: "login" } });
	};

	const pick = (entryId: string) => {
		setTotpForEntry(entryId, key);
		void navigate({ to: "/vault/$entryId/edit", params: { entryId } });
	};

	return (
		<TotpSetup
			issuer={parsed?.issuer ?? ""}
			account={parsed?.account ?? ""}
			targets={targets}
			query={query}
			onQueryChange={setQuery}
			onCreateNew={createNew}
			onPick={pick}
		/>
	);
}
