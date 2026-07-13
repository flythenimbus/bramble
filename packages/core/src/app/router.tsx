import {
	createMemoryHistory,
	createRootRouteWithContext,
	createRoute,
	createRouter,
	Outlet,
	redirect,
} from "@tanstack/react-router";
import type { UseVault } from "../hooks/useVault";
import { AppLayout } from "./layouts/AppLayout";
import { AuthRoute } from "./routes/AuthRoute";
import { CreateEntryRoute } from "./routes/CreateEntryRoute";
import { EntryDetailRoute } from "./routes/EntryDetailRoute";
import { EntryEditRoute } from "./routes/EntryEditRoute";
import { SettingsRoute } from "./routes/SettingsRoute";
import { VaultHomeRoute } from "./routes/VaultHomeRoute";
import { settingsSearchSchema } from "./screens/Settings/settings-search";
import { vaultSearchSchema } from "./screens/VaultHome/vault-search";

// Slice of vault state route guards read; injected via RouterProvider context.
// Stays `undefined` until React fills it, so guards treat missing vault as
// "not ready, don't decide".
type VaultGuard = Pick<UseVault, "isLocked" | "ready" | "entries">;

/** Router context: vault guard slice, undefined until React injects it. */
export interface RouterContext {
	vault: VaultGuard | undefined;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
	component: () => <Outlet />,
});

const authRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/",
	// WARNING: intentionally NOT gated on `ready`. Adding a ready gate here
	// "for symmetry" with _app reintroduces a redirect loop.
	beforeLoad: ({ context }) => {
		if (context.vault && !context.vault.isLocked) throw redirect({ to: "/vault" });
	},
	component: AuthRoute,
});

const appLayoutRoute = createRoute({
	getParentRoute: () => rootRoute,
	id: "_app",
	// Guard for all authed routes: bounce to the unlock screen when locked.
	// Gated on `ready` to avoid redirecting a popped-out window pre-hydration.
	beforeLoad: ({ context }) => {
		if (context.vault?.ready && context.vault.isLocked) throw redirect({ to: "/" });
	},
	component: AppLayout,
});

const vaultHomeRoute = createRoute({
	getParentRoute: () => appLayoutRoute,
	path: "/vault",
	// Search/filter/sort live in the route so they survive navigating to a detail
	// view and back. Zod-validated (all fields optional); VaultHomeRoute merges in
	// the defaults for any absent/dropped param.
	validateSearch: vaultSearchSchema,
	component: VaultHomeRoute,
});

const createEntryRoute = createRoute({
	getParentRoute: () => appLayoutRoute,
	path: "/vault/new/$type",
	staticData: { back: { to: "/vault" } },
	component: CreateEntryRoute,
});

const entryDetailRoute = createRoute({
	getParentRoute: () => appLayoutRoute,
	path: "/vault/$entryId",
	staticData: { back: { to: "/vault" } },
	// Bail to the vault list on a stale id. Gated on `ready` so a detached
	// window doesn't bounce before `entries` has hydrated.
	beforeLoad: ({ context, params }) => {
		if (context.vault?.ready && !context.vault.entries.find((e) => e.id === params.entryId)) {
			throw redirect({ to: "/vault" });
		}
	},
	component: EntryDetailRoute,
});

const entryEditRoute = createRoute({
	getParentRoute: () => appLayoutRoute,
	path: "/vault/$entryId/edit",
	staticData: { back: { to: "/vault/$entryId", paramKeys: ["entryId"] } },
	beforeLoad: ({ context, params }) => {
		if (context.vault?.ready && !context.vault.entries.find((e) => e.id === params.entryId)) {
			throw redirect({ to: "/vault" });
		}
	},
	component: EntryEditRoute,
});

const settingsRoute = createRoute({
	getParentRoute: () => appLayoutRoute,
	path: "/settings",
	// Active tab in search params so it survives navigation + popup close/reopen.
	validateSearch: settingsSearchSchema,
	staticData: { back: { to: "/vault" } },
	component: SettingsRoute,
});

const routeTree = rootRoute.addChildren([
	authRoute,
	appLayoutRoute.addChildren([
		vaultHomeRoute,
		createEntryRoute,
		entryDetailRoute,
		entryEditRoute,
		settingsRoute,
	]),
]);

/**
 * Build a fresh memory-history router. `initialPath` seeds the route so a
 * popped-out window resumes where the user left (default "/").
 */
export function createAppRouter(initialPath = "/") {
	return createRouter({
		routeTree,
		history: createMemoryHistory({ initialEntries: [initialPath] }),
		context: { vault: undefined },
	});
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module "@tanstack/react-router" {
	interface Register {
		router: AppRouter;
	}

	// Fallback target for the header Back button when there's no history to pop
	// (e.g. a popped-out window booted onto a deep route). `paramKeys` lists the
	// path params `to` needs, resolved in AppLayout from the current params.
	interface StaticDataRouteOption {
		back?: { to: string; paramKeys?: readonly string[] };
	}
}
