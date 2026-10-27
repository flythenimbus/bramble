/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { InlineConfirm, type InlineConfirmProps } from "./inline-confirm";

afterEach(cleanup);
beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});

function renderConfirm(props: Partial<InlineConfirmProps> = {}) {
	return render(
		<I18nProvider i18n={i18n}>
			<InlineConfirm
				confirmLabel="Delete"
				busyLabel="Deleting…"
				onConfirm={async () => {}}
				trigger={(arm) => (
					<button type="button" onClick={arm}>
						Trash
					</button>
				)}
				{...props}
			/>
		</I18nProvider>,
	);
}

describe("InlineConfirm", () => {
	it("acts only on the second, confirming click", async () => {
		const onConfirm = vi.fn(async () => {});
		renderConfirm({ onConfirm });
		fireEvent.click(screen.getByRole("button", { name: "Trash" }));
		expect(onConfirm).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Delete" }));
		await vi.waitFor(() => expect(onConfirm).toHaveBeenCalledOnce());
		// Back to the trigger once it is done.
		await vi.waitFor(() => screen.getByRole("button", { name: "Trash" }));
	});

	// A stray Enter right after arming must back out, not destroy.
	it("puts focus on Cancel when it asks", () => {
		renderConfirm();
		fireEvent.click(screen.getByRole("button", { name: "Trash" }));
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
	});

	it("backs out on Cancel or Escape without acting", () => {
		const onConfirm = vi.fn();
		renderConfirm({ onConfirm });
		fireEvent.click(screen.getByRole("button", { name: "Trash" }));
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		fireEvent.click(screen.getByRole("button", { name: "Trash" }));
		fireEvent.keyDown(screen.getByRole("group"), { key: "Escape" });
		screen.getByRole("button", { name: "Trash" });
		expect(onConfirm).not.toHaveBeenCalled();
	});

	it("shows the busy label and holds both buttons while it runs", async () => {
		let finish = () => {};
		renderConfirm({ onConfirm: () => new Promise<void>((r) => (finish = r)) });
		fireEvent.click(screen.getByRole("button", { name: "Trash" }));
		fireEvent.click(screen.getByRole("button", { name: "Delete" }));
		const busy = await screen.findByRole("button", { name: "Deleting…" });
		expect(busy).toHaveProperty("disabled", true);
		expect(screen.getByRole("button", { name: "Cancel" })).toHaveProperty("disabled", true);
		finish();
		await vi.waitFor(() => screen.getByRole("button", { name: "Trash" }));
	});

	it("keeps asking and says why when the action fails", async () => {
		renderConfirm({
			onConfirm: async () => {
				throw new Error("disk full");
			},
		});
		fireEvent.click(screen.getByRole("button", { name: "Trash" }));
		fireEvent.click(screen.getByRole("button", { name: "Delete" }));
		await screen.findByText("disk full");
		screen.getByRole("button", { name: "Delete" });
	});

	it("hands a failure to onError instead, when given one", async () => {
		const onError = vi.fn();
		renderConfirm({
			onError,
			onConfirm: async () => {
				throw new Error("disk full");
			},
		});
		fireEvent.click(screen.getByRole("button", { name: "Trash" }));
		fireEvent.click(screen.getByRole("button", { name: "Delete" }));
		await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
		expect(screen.queryByText("disk full")).toBeNull();
	});

	it("can be driven by its caller", () => {
		function Controlled() {
			const [armed, setArmed] = useState(false);
			return (
				<I18nProvider i18n={i18n}>
					{armed && <p>asking</p>}
					<InlineConfirm
						armed={armed}
						onArmedChange={setArmed}
						confirmLabel="Delete"
						onConfirm={() => {}}
						trigger={(arm) => (
							<button type="button" onClick={arm}>
								Trash
							</button>
						)}
					/>
				</I18nProvider>
			);
		}
		render(<Controlled />);
		fireEvent.click(screen.getByRole("button", { name: "Trash" }));
		screen.getByText("asking");
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(screen.queryByText("asking")).toBeNull();
	});
});
