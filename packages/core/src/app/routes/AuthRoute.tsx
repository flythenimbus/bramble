import { useVault } from "../../hooks/useVault";
import { Auth } from "../screens/Auth/Auth";

/** Route wrapper for the Auth screen; the already-unlocked redirect lives in beforeLoad. */
export function AuthRoute() {
	const { ready } = useVault();
	// A view reopened on an unlocked vault reads as locked until its entries are in. That is a
	// moment to show nothing, not an unlock form to start typing in.
	if (!ready) return null;
	return <Auth />;
}
