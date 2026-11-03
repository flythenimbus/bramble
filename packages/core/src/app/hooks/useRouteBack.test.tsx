/** @vitest-environment happy-dom */
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
	RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRouteBack } from "./useRouteBack";

afterEach(cleanup);

let back: (() => void) | null = null;

function Capture() {
	back = useRouteBack();
	return null;
}

// The vault's shape: list, detail (back to the list), edit (back to its detail).
function mount(initialPath: string) {
	const root = createRootRoute({
		component: () => (
			<>
				<Capture />
				<Outlet />
			</>
		),
	});
	const list = createRoute({ getParentRoute: () => root, path: "/vault" });
	const detail = createRoute({
		getParentRoute: () => root,
		path: "/vault/$entryId",
		staticData: { back: { to: "/vault" } },
	});
	const edit = createRoute({
		getParentRoute: () => root,
		path: "/vault/$entryId/edit",
		staticData: { back: { to: "/vault/$entryId", paramKeys: ["entryId"] } },
	});
	const history = createMemoryHistory({ initialEntries: [initialPath] });
	const router = createRouter({ routeTree: root.addChildren([list, detail, edit]), history });
	render(<RouterProvider router={router} />);
	return router;
}

// Settled, not just requested: the route's matches render before `back` describes them.
async function at(router: ReturnType<typeof mount>, pathname: string) {
	await vi.waitFor(() => {
		expect(router.state.resolvedLocation?.pathname).toBe(pathname);
		expect(router.state.status).toBe("idle");
	});
	await act(async () => {});
}

async function goBack(router: ReturnType<typeof mount>, pathname: string) {
	await act(async () => back?.());
	await at(router, pathname);
}

describe("useRouteBack", () => {
	// #150: the form pushed its detail after a save, so back from the detail reopened the form.
	it("leaves an edit opened from the detail back to it, then to the list", async () => {
		const router = mount("/vault");
		await at(router, "/vault");
		expect(back).toBeNull();
		await act(() => router.navigate({ to: "/vault/$entryId", params: { entryId: "e" } }));
		await act(() => router.navigate({ to: "/vault/$entryId/edit", params: { entryId: "e" } }));
		await at(router, "/vault/e/edit");
		await goBack(router, "/vault/e"); // the form's Update
		await goBack(router, "/vault"); // the header's back
	});

	it("returns an edit opened from the list to the list", async () => {
		const router = mount("/vault");
		await act(() => router.navigate({ to: "/vault/$entryId/edit", params: { entryId: "e" } }));
		await at(router, "/vault/e/edit");
		await goBack(router, "/vault");
	});

	// A pop-out window boots straight onto the route, with nothing behind it.
	it("falls back to the route's target, replacing it so it can't be returned to", async () => {
		const router = mount("/vault/e/edit");
		await at(router, "/vault/e/edit");
		await goBack(router, "/vault/e");
		expect(router.history.canGoBack()).toBe(false);
		await goBack(router, "/vault");
	});
});
