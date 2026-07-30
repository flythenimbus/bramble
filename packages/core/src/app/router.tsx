import {
	createMemoryHistory,
	createRootRouteWithContext,
	createRoute,
	createRouter,
	lazyRouteComponent,
	Outlet,
	redirect,
} from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import type { UseVault } from "../hooks/useVault";
import { AppLayout } from "./layouts/AppLayout";
import { AuthRoute } from "./routes/AuthRoute";
import { VaultHomeRoute } from "./routes/VaultHomeRoute";
import { settingsSearchSchema } from "./screens/Settings/settings-search";
import { vaultSearchSchema } from "./screens/VaultHome/vault-search";

// Code-split the routes that aren't on the first-paint path (Settings pulls in
// backup/sync/import/restore; the entry forms pull in every field editor). The
// unlock screen, the app shell, and the vault list stay eager so opening the app
// needs no extra chunk fetch. Navigating to these shows the current view until
// the chunk resolves (TanStack Router's pending behavior), so no blank flash.
const SelectVaultRoute = lazyRouteComponent(
	() => import("./routes/SelectVaultRoute"),
	"SelectVaultRoute",
);
const CreateEntryRoute = lazyRouteComponent(
	() => import("./routes/CreateEntryRoute"),
	"CreateEntryRoute",
);
const EntryDetailRoute = lazyRouteComponent(
	() => import("./routes/EntryDetailRoute"),
	"EntryDetailRoute",
);
const EntryEditRoute = lazyRouteComponent(
	() => import("./routes/EntryEditRoute"),
	"EntryEditRoute",
);
const SettingsRoute = lazyRouteComponent(() => import("./routes/SettingsRoute"), "SettingsRoute");

// Slice of vault state route guards read; injected via RouterProvider context.
// Stays `undefined` until React fills it, so guards treat missing vault as
// "not ready, don't decide".
type VaultGuard = Pick<UseVault, "isLocked" | "ready" | "entries">;

// Registry slice for the launch-time picker decision: how many vaults exist and whether
// one is chosen. Undefined until React injects it, like the vault slice.
interface RegistryGuard {
	ready: boolean;
	count: number;
	hasActive: boolean;
}

/** Router context: guard slices, undefined until React injects them. */
interface RouterContext {
	vault: VaultGuard | undefined;
	registry: RegistryGuard | undefined;
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
		// Several vaults and none chosen yet: pick one first.
		if (context.registry?.ready && context.registry.count > 1 && !context.registry.hasActive) {
			throw redirect({ to: "/select" });
		}
	},
	component: AuthRoute,
});

const selectVaultRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/select",
	// Show the picker only when several vaults exist and none is chosen; otherwise the unlock
	// screen (or the vault, if already unlocked). Exact complement of authRoute, so no loop.
	beforeLoad: ({ context }) => {
		if (context.vault && !context.vault.isLocked) throw redirect({ to: "/vault" });
		if (context.registry?.ready && (context.registry.count <= 1 || context.registry.hasActive)) {
			throw redirect({ to: "/" });
		}
	},
	component: SelectVaultRoute,
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
	selectVaultRoute,
	appLayoutRoute.addChildren([
		vaultHomeRoute,
		createEntryRoute,
		entryDetailRoute,
		entryEditRoute,
		settingsRoute,
	]),
]);

// Shown only when a lazy route's chunk stays pending past defaultPendingMs (1s);
// local chunks resolve in ms, so in practice this never renders — it's the
// graceful fallback for a genuinely slow load rather than blanking the app.
function RoutePending() {
	return (
		<div className="flex-1 min-h-0 flex items-center justify-center">
			<Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
		</div>
	);
}

/**
 * Build a fresh memory-history router. `initialPath` seeds the route so a
 * popped-out window resumes where the user left (default "/").
 */
export function createAppRouter(initialPath = "/") {
	return createRouter({
		routeTree,
		history: createMemoryHistory({ initialEntries: [initialPath] }),
		context: { vault: undefined, registry: undefined },
		defaultPendingComponent: RoutePending,
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
