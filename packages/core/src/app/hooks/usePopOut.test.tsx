/** @vitest-environment happy-dom */
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { type Platform, PlatformProvider } from "../../context/PlatformContext";
import type { AppRouter } from "../router";
import { PopOutProvider, usePopOut } from "./usePopOut";

vi.mock("../../hooks/useVaultRegistry", () => ({
	useVaultRegistry: () => ({ activeId: "v1" }),
}));

function controls() {
	const sent = vi.fn(async () => {});
	const platform = {
		target: "chromium",
		shell: { popOut: sent, isDetached: () => false },
	} as unknown as Platform;
	const router = { state: { location: { href: "/vault" } } } as unknown as AppRouter;
	let captured: ReturnType<typeof usePopOut> | null = null;
	function Probe() {
		captured = usePopOut();
		return null;
	}
	render(
		<PlatformProvider platform={platform}>
			<PopOutProvider router={router}>
				<Probe />
			</PopOutProvider>
		</PlatformProvider>,
	);
	return { pop: captured as unknown as ReturnType<typeof usePopOut>, sent };
}

describe("popOut", () => {
	it("hands over no draft when used directly as a click handler", () => {
		const { pop, sent } = controls();
		// What `onClick={popOut}` does: React passes the click event, which no browser can send.
		(pop.popOut as (e: unknown) => void)({ type: "click", view: globalThis });
		expect(sent).toHaveBeenCalledWith({ path: "/vault", draft: undefined, vaultId: "v1" });
	});

	it("hands over an explicit draft only through popOutWith", () => {
		const { pop, sent } = controls();
		pop.popOutWith({ webauthn: "unlock" });
		expect(sent).toHaveBeenCalledWith({
			path: "/vault",
			draft: { webauthn: "unlock" },
			vaultId: "v1",
		});
	});
});
