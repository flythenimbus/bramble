/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { type FieldValues, FormProvider, useForm } from "react-hook-form";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TagsEditor } from "./tags";

afterEach(cleanup);

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
	// happy-dom has no layout, so scrollIntoView is absent; the chips call it on focus.
	Element.prototype.scrollIntoView = vi.fn();
	globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
		setTimeout(() => cb(0), 0) as unknown as number) as typeof requestAnimationFrame;
});

function Host({ tags = [], suggestions = [] }: { tags?: string[]; suggestions?: string[] }) {
	const methods = useForm<FieldValues>({ defaultValues: { tags } });
	return (
		<I18nProvider i18n={i18n}>
			<FormProvider {...methods}>
				<TagsEditor suggestions={suggestions} />
			</FormProvider>
		</I18nProvider>
	);
}

const input = () => screen.getByLabelText("Add a tag");
const chipRemovers = () => screen.queryAllByRole("button", { name: /^Remove tag/ });
const menuItems = () => screen.queryAllByRole("menuitem");

describe("TagsEditor", () => {
	it("commits a tag on Enter and clears the draft", () => {
		render(<Host />);
		fireEvent.change(input(), { target: { value: "work" } });
		fireEvent.keyDown(input(), { key: "Enter" });
		expect(screen.getByText("work")).toBeTruthy();
		expect((input() as HTMLInputElement).value).toBe("");
	});

	// People paste "work, banking" out of another manager; Enter alone would store one tag.
	it("commits on a comma too", () => {
		render(<Host />);
		fireEvent.change(input(), { target: { value: "work" } });
		fireEvent.keyDown(input(), { key: "," });
		expect(screen.getByText("work")).toBeTruthy();
	});

	it("normalizes on commit, so a duplicate spelling does not become a second chip", () => {
		render(<Host tags={["Work"]} />);
		fireEvent.change(input(), { target: { value: "work" } });
		fireEvent.keyDown(input(), { key: "Enter" });
		expect(chipRemovers()).toHaveLength(1);
	});

	it("peels off the last chip with Backspace on an empty draft", () => {
		render(<Host tags={["a", "b"]} />);
		fireEvent.keyDown(input(), { key: "Backspace" });
		expect(screen.queryByText("b")).toBeNull();
		expect(screen.getByText("a")).toBeTruthy();
	});

	it("leaves the chips alone when Backspace has text to delete", () => {
		render(<Host tags={["a"]} />);
		fireEvent.change(input(), { target: { value: "x" } });
		fireEvent.keyDown(input(), { key: "Backspace" });
		expect(screen.getByText("a")).toBeTruthy();
	});

	// The row scrolls rather than wrapping, so a chip can be off screen. The arrow keys are
	// the only way to reach one that is, which makes this the load-bearing interaction.
	it("steps into the chips with ArrowLeft and back out with ArrowRight", () => {
		render(<Host tags={["a", "b"]} />);
		fireEvent.keyDown(input(), { key: "ArrowLeft" });
		expect(document.activeElement).toBe(chipRemovers()[1]);

		fireEvent.keyDown(chipRemovers()[1] as Element, { key: "ArrowLeft" });
		expect(document.activeElement).toBe(chipRemovers()[0]);

		fireEvent.keyDown(chipRemovers()[0] as Element, { key: "ArrowRight" });
		expect(document.activeElement).toBe(chipRemovers()[1]);

		fireEvent.keyDown(chipRemovers()[1] as Element, { key: "ArrowRight" });
		expect(document.activeElement).toBe(input());
	});

	it("brings a focused chip into view, since it may have scrolled off", () => {
		render(<Host tags={["a"]} />);
		fireEvent.focus(chipRemovers()[0] as Element);
		expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
	});

	it("stays put on ArrowLeft at the first chip rather than falling out of the field", () => {
		render(<Host tags={["a", "b"]} />);
		fireEvent.keyDown(chipRemovers()[0] as Element, { key: "ArrowLeft" });
		expect(document.activeElement).toBe(chipRemovers()[0]);
	});

	it("removes the focused chip with Delete", () => {
		render(<Host tags={["a", "b"]} />);
		fireEvent.keyDown(chipRemovers()[0] as Element, { key: "Delete" });
		expect(screen.queryByText("a")).toBeNull();
		expect(screen.getByText("b")).toBeTruthy();
	});

	it("returns to the input when a character is typed while a chip has focus", () => {
		render(<Host tags={["a"]} />);
		fireEvent.keyDown(chipRemovers()[0] as Element, { key: "x" });
		expect(document.activeElement).toBe(input());
	});

	it("commits a typed-but-unconfirmed tag when focus leaves, instead of dropping it", () => {
		render(<Host />);
		fireEvent.change(input(), { target: { value: "work" } });
		fireEvent.blur(input(), { relatedTarget: null });
		expect(screen.getByText("work")).toBeTruthy();
	});

	// The menu is an overlay tied to focus, not a permanent strip under the field.
	it("stays closed until the field takes focus", () => {
		render(<Host suggestions={["work"]} />);
		expect(screen.queryByRole("menu")).toBeNull();
		fireEvent.focus(input());
		expect(screen.queryByRole("menu")).toBeTruthy();
	});

	it("offers the whole vocabulary on focus, before anything is typed", () => {
		render(<Host suggestions={["work", "banking"]} />);
		fireEvent.focus(input());
		expect(menuItems().map((i) => i.textContent)).toEqual(["work", "banking"]);
	});

	it("narrows the menu as the draft is typed", () => {
		render(<Host suggestions={["work", "banking"]} />);
		fireEvent.focus(input());
		fireEvent.change(input(), { target: { value: "wo" } });
		expect(menuItems().map((i) => i.textContent)).toEqual(["work"]);
	});

	// Tab commits the draft, so it cannot also reach the menu. Without a way in, the
	// suggestions would be visible and keyboard-unreachable at the moment they show.
	it("walks the menu with the arrow keys and comes back to the input", () => {
		render(<Host suggestions={["work", "banking"]} />);
		fireEvent.focus(input());
		fireEvent.keyDown(input(), { key: "ArrowDown" });
		expect(document.activeElement).toBe(menuItems()[0]);

		fireEvent.keyDown(menuItems()[0] as Element, { key: "ArrowDown" });
		expect(document.activeElement).toBe(menuItems()[1]);

		// Up from the first item returns to the query rather than wrapping to the bottom.
		fireEvent.keyDown(menuItems()[0] as Element, { key: "ArrowUp" });
		expect(document.activeElement).toBe(input());
	});

	it("returns focus to the input after a suggestion is picked", () => {
		render(<Host suggestions={["work"]} />);
		fireEvent.focus(input());
		fireEvent.click(menuItems()[0] as Element);
		expect(document.activeElement).toBe(input());
		expect(screen.getByText("work")).toBeTruthy();
	});

	// Clicking a suggestion must not blur the input first: blur commits the draft, so
	// picking "work" after typing "wo" would otherwise store "wo".
	it("keeps focus in the input while a suggestion is being clicked", () => {
		render(<Host suggestions={["work"]} />);
		fireEvent.focus(input());
		fireEvent.change(input(), { target: { value: "wo" } });
		const prevented = !fireEvent.mouseDown(menuItems()[0] as Element);
		expect(prevented).toBe(true);
	});

	it("dismisses on Escape without giving up the field", () => {
		render(<Host suggestions={["work"]} />);
		fireEvent.focus(input());
		fireEvent.keyDown(input(), { key: "Escape" });
		expect(screen.queryByRole("menu")).toBeNull();
		fireEvent.change(input(), { target: { value: "w" } });
		expect(screen.queryByRole("menu")).toBeTruthy();
	});

	it("closes when focus leaves the field entirely", () => {
		render(
			<>
				<Host suggestions={["work"]} />
				<button type="button">elsewhere</button>
			</>,
		);
		fireEvent.focus(input());
		expect(screen.queryByRole("menu")).toBeTruthy();
		fireEvent.blur(input(), {
			relatedTarget: screen.getByRole("button", { name: "elsewhere" }),
		});
		expect(screen.queryByRole("menu")).toBeNull();
	});

	it("announces an added tag, since the change happens away from the caret", () => {
		render(<Host />);
		fireEvent.change(input(), { target: { value: "work" } });
		fireEvent.keyDown(input(), { key: "Enter" });
		expect(screen.getByRole("status").textContent).toContain("work");
	});

	it("announces a removed tag", () => {
		render(<Host tags={["work"]} />);
		fireEvent.keyDown(input(), { key: "Backspace" });
		expect(screen.getByRole("status").textContent).toContain("work");
	});

	// Normalization can rewrite what was typed, and the announcement has to match what was
	// actually stored or it tells the user something untrue.
	it("announces the stored spelling, not the typed one", () => {
		render(<Host />);
		fireEvent.change(input(), { target: { value: "shared household" } });
		fireEvent.keyDown(input(), { key: "Enter" });
		expect(screen.getByRole("status").textContent).toContain("shared-household");
	});

	it("describes the keyboard mechanics, which are invisible to a screen reader", () => {
		render(<Host />);
		const describedBy = input().getAttribute("aria-describedby");
		expect(describedBy).toBeTruthy();
		const hint = document.getElementById((describedBy ?? "").split(" ")[0] ?? "");
		expect(hint?.textContent).toMatch(/Enter/);
	});

	it("offers only suggestions the entry does not already carry", () => {
		render(<Host tags={["work"]} suggestions={["work", "banking"]} />);
		fireEvent.focus(input());
		expect(menuItems().map((i) => i.textContent)).toEqual(["banking"]);
	});
});
