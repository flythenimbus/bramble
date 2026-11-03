import { useMatches, useNavigate, useParams, useRouter } from "@tanstack/react-router";

/**
 * Leave the current route: back through real history (so Edit from the list returns to the
 * list), else to the route's staticData.back, replacing this entry, since a popped-out window
 * booted straight onto a deep route has nothing behind it. paramKeys resolves the fallback's
 * path params from the current ones. Null on a route without a back target.
 *
 * The header's back button and a form's Cancel and Save all leave this way. A form that pushed
 * its parent instead left itself in history, so back from the parent reopened the form (#150).
 */
export function useRouteBack(): (() => void) | null {
	const router = useRouter();
	const navigate = useNavigate();
	const matches = useMatches();
	const params = useParams({ strict: false }) as Record<string, string>;
	const backData = matches.at(-1)?.staticData.back;
	if (!backData) return null;
	return () => {
		if (router.history.canGoBack()) {
			router.history.back();
			return;
		}
		navigate({
			to: backData.to,
			params: Object.fromEntries((backData.paramKeys ?? []).map((k) => [k, params[k]])),
			replace: true,
		});
	};
}
