import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
} from "@tanstack/react-router";
import { AppLayout } from "./layouts/AppLayout";
import { AuthRoute } from "./routes/AuthRoute";
import { CreateEntryRoute } from "./routes/CreateEntryRoute";
import { EntryDetailRoute } from "./routes/EntryDetailRoute";
import { EntryEditRoute } from "./routes/EntryEditRoute";
import { SettingsRoute } from "./routes/SettingsRoute";
import { VaultHomeRoute } from "./routes/VaultHomeRoute";

const rootRoute = createRootRoute({
	component: () => <Outlet />,
});

const authRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/",
	component: AuthRoute,
});

const appLayoutRoute = createRoute({
	getParentRoute: () => rootRoute,
	id: "_app",
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
	component: CreateEntryRoute,
});

const entryDetailRoute = createRoute({
	getParentRoute: () => appLayoutRoute,
	path: "/vault/$entryId",
	component: EntryDetailRoute,
});

const entryEditRoute = createRoute({
	getParentRoute: () => appLayoutRoute,
	path: "/vault/$entryId/edit",
	component: EntryEditRoute,
});

const settingsRoute = createRoute({
	getParentRoute: () => appLayoutRoute,
	path: "/settings",
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

export function createAppRouter(initialPath = "/") {
	return createRouter({
		routeTree,
		history: createMemoryHistory({ initialEntries: [initialPath] }),
	});
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module "@tanstack/react-router" {
	interface Register {
		router: AppRouter;
	}
}
