import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
} from "@tanstack/react-router";
import { AppLayout } from "./layouts/AppLayout";
import { AuthRoute } from "./routes/AuthRoute";
import { CreatePasswordRoute } from "./routes/CreatePasswordRoute";
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

const createPasswordRoute = createRoute({
	getParentRoute: () => appLayoutRoute,
	path: "/vault/new",
	component: CreatePasswordRoute,
});

const settingsRoute = createRoute({
	getParentRoute: () => appLayoutRoute,
	path: "/settings",
	component: SettingsRoute,
});

const routeTree = rootRoute.addChildren([
	authRoute,
	appLayoutRoute.addChildren([vaultHomeRoute, createPasswordRoute, settingsRoute]),
]);

export const router = createRouter({
	routeTree,
	history: createMemoryHistory({ initialEntries: ["/"] }),
});

declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router;
	}
}
