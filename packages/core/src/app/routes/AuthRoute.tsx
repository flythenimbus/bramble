import { Auth } from "../screens/Auth/Auth";

/** Route wrapper for the Auth screen; the already-unlocked redirect lives in beforeLoad. */
export function AuthRoute() {
	return <Auth />;
}
