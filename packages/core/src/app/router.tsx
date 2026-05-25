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

type VaultGuard = Pick<UseVault, "isLocked" | "ready" | "entries">;

export interface RouterContext {
	vault: VaultGuard | undefined;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
	component: () => <Outlet />,
});

const authRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/",
	beforeLoad: ({ context }) => {
		if (context.vault && !context.vault.isLocked) throw redirect({ to: "/vault" });
	},
	component: AuthRoute,
});

const appLayoutRoute = createRoute({
	getParentRoute: () => rootRoute,
	id: "_app",
	beforeLoad: ({ context }) => {
		if (context.vault?.ready && context.vault.isLocked) throw redirect({ to: "/" });
	},
	component: AppLayout,
});

const vaultHomeRoute = createRoute({
	getParentRoute: () => appLayoutRoute,
	path: "/vault",
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

//
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

	interface StaticDataRouteOption {
		back?: { to: string; paramKeys?: readonly string[] };
	}
}
