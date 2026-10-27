import { expect, test } from "./fixtures";
import { openExampleLogin } from "./helpers";

// Delete sits in the card's footer, away from Edit (#94), and asks directly beneath it.
test("deleting an entry asks beneath the button, in view", async ({ context, extensionId }) => {
	const popup = await openExampleLogin(context, extensionId);

	await popup.getByRole("button", { name: "Delete entry" }).click();
	const question = popup.getByText("Delete this entry permanently?");
	await expect(question).toBeInViewport();
	await popup.getByRole("button", { name: "Cancel" }).click();
	await expect(question).toHaveCount(0);

	await popup.getByRole("button", { name: "Delete entry" }).click();
	await popup.getByRole("button", { name: "Delete", exact: true }).click();
	await expect(popup.getByText("Example Login")).toHaveCount(0);
});
