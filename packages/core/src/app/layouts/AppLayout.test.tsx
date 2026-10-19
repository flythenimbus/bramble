/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type Platform, PlatformProvider } from "../../context/PlatformContext";
import { PopOutProvider, usePopOut } from "../hooks/usePopOut";
import type { AppRouter } from "../router";
import { AppLayout } from "./AppLayout";

vi.mock("@tanstack/react-router", () => ({
	Outlet: () => null,
	useMatches: () => [],
	useNavigate: () => vi.fn(),
	useParams: () => ({}),
	useRouter: () => ({}),
}));

vi.mock("../../hooks/useVault", () => ({
	useVault: () => ({ lock: vi.fn() }),
}));

vi.mock("../../hooks/useVaultRegistry", () => ({
	useVaultRegistry: () => ({ activeId: "vault-1", vaults: [] }),
}));

vi.mock("../components/PasskeySavedToast", () => ({
	PasskeySavedToast: () => null,
}));

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});

afterEach(cleanup);

function DraftRegistration({ getter }: { getter: () => unknown }) {
	const { registerDraftGetter } = usePopOut();
	useEffect(() => {
		registerDraftGetter(getter);
		return () => registerDraftGetter(null);
	}, [getter, registerDraftGetter]);
	return null;
}

describe("AppLayout pop-out button", () => {
	it.each([
		{ name: "without a form draft", draft: undefined },
		{ name: "with an unsaved form draft", draft: { title: "Unsaved login", username: "alice" } },
	])("opens the current route $name without forwarding the click event", ({ draft }) => {
		const popOut = vi.fn().mockResolvedValue(undefined);
		const getter = vi.fn(() => draft);
		const platform = {
			target: "chromium",
			shell: { appName: "Bramble", isDetached: () => false, popOut },
		} as unknown as Platform;
		const router = {
			state: { location: { href: "/vault/entry/new" } },
		} as unknown as AppRouter;

		render(
			<I18nProvider i18n={i18n}>
				<PlatformProvider platform={platform}>
					<PopOutProvider router={router}>
						<DraftRegistration getter={getter} />
						<AppLayout />
					</PopOutProvider>
				</PlatformProvider>
			</I18nProvider>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Open in window" }));

		expect(getter).toHaveBeenCalledOnce();
		expect(popOut).toHaveBeenCalledExactlyOnceWith({
			path: "/vault/entry/new",
			draft,
			vaultId: "vault-1",
		});
	});
});
