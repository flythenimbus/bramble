/** @vitest-environment happy-dom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthRoute } from "./AuthRoute";

const h = vi.hoisted(() => ({ ready: false }));

vi.mock("../../hooks/useVault", () => ({ useVault: () => ({ ready: h.ready }) }));
vi.mock("../screens/Auth/Auth", () => ({ Auth: () => <p>unlock form</p> }));

afterEach(cleanup);

describe("AuthRoute", () => {
	it("shows no unlock form while the provider is still finding out if the vault is open", () => {
		// A view reopened on an unlocked vault reads as locked until its entries are in.
		h.ready = false;
		render(<AuthRoute />);
		expect(screen.queryByText("unlock form")).toBeNull();
	});

	it("shows the unlock form once it knows the vault is locked", () => {
		h.ready = true;
		render(<AuthRoute />);
		expect(screen.getByText("unlock form")).toBeTruthy();
	});
});
