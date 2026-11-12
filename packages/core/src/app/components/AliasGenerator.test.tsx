/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AliasError } from "../../aliases";
import { type Platform, PlatformProvider } from "../../context/PlatformContext";
import { AliasGenerator } from "./AliasGenerator";

// #120: an alias on its own, from the generator screen, without making a login first.

const h = vi.hoisted(() => ({
	enabled: true,
	generate: (async () => "") as (site?: string) => Promise<string>,
	navigate: (() => {}) as (to: unknown) => void,
	copied: [] as string[],
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => h.navigate }));
vi.mock("../../hooks/useAliasProvider", () => ({
	useAliasProvider: () => ({ enabled: h.enabled, generate: h.generate }),
}));

const platform = {
	clipboard: { copy: async (v: string) => void h.copied.push(v) },
} as unknown as Platform;

function mount() {
	return render(
		<I18nProvider i18n={i18n}>
			<PlatformProvider platform={platform}>
				<AliasGenerator />
			</PlatformProvider>
		</I18nProvider>,
	);
}

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});
beforeEach(() => {
	h.enabled = true;
	h.generate = vi.fn(async () => "x7k2@aliases.test");
	h.navigate = vi.fn();
	h.copied = [];
});
afterEach(cleanup);

describe("AliasGenerator", () => {
	it("creates an alias for the site typed, only on the button, and copies it", async () => {
		mount();
		expect(h.generate).not.toHaveBeenCalled();
		fireEvent.change(screen.getByLabelText("Website (optional)"), {
			target: { value: "https://www.github.com/signup" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Create alias" }));
		expect(await screen.findByText("x7k2@aliases.test")).toBeTruthy();
		expect(h.generate).toHaveBeenCalledWith("www.github.com");

		fireEvent.click(screen.getByRole("button", { name: "Copy" }));
		await vi.waitFor(() => expect(h.copied).toEqual(["x7k2@aliases.test"]));
	});

	it("creates one with no site when the field is empty", async () => {
		mount();
		fireEvent.click(screen.getByRole("button", { name: "Create alias" }));
		await screen.findByText("x7k2@aliases.test");
		expect(h.generate).toHaveBeenCalledWith(undefined);
	});

	it("shows the provider's own words when it refuses", async () => {
		h.generate = vi.fn(async () => {
			throw new AliasError("payment", "Couldn't create an alias.", {
				status: 402,
				providerMessage: "Upgrade to continue.",
			});
		});
		mount();
		fireEvent.click(screen.getByRole("button", { name: "Create alias" }));
		expect(await screen.findByText("Couldn't create an alias. Upgrade to continue.")).toBeTruthy();
	});

	it("points to Settings when no provider is set up", () => {
		h.enabled = false;
		mount();
		expect(screen.queryByRole("button", { name: "Create alias" })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Set up aliases" }));
		expect(h.navigate).toHaveBeenCalledWith({ to: "/settings", search: { tab: "aliases" } });
	});
});
