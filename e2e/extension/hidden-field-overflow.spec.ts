import { expect, test } from "./fixtures";
import { createVault, openPopup } from "./helpers";

// A revealed hidden custom field used to spill past its row's border: `truncate` on an inline
// <span> is a no-op (overflow doesn't apply to inline boxes), so a long value ran off the card.

const LONG_SECRET = "EsU9 R4vR 5L66 fZVT Ym7g cR7Z fXs7 z1vF T3p4 qRrb 2hTt 9dLm";

test("a revealed hidden custom field stays inside its row", async ({ context, extensionId }) => {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);

	await popup.getByRole("button", { name: /Add New/i }).click();
	await popup.getByRole("button", { name: /Add a new login/i }).click();
	await popup.getByLabel("Name", { exact: true }).fill("Recovery holder");
	await popup.getByRole("button", { name: /Add field/i }).click();
	await popup.getByLabel("Field name", { exact: true }).fill("Recovery key");
	await popup.getByLabel("Type", { exact: true }).selectOption("password");
	await popup.getByLabel("Value", { exact: true }).fill(LONG_SECRET);
	await popup.getByRole("button", { name: /Save Login/i }).click();

	await popup.getByText("Recovery holder").click();
	await popup.getByRole("button", { name: "Show value" }).click();
	const value = popup.getByText(LONG_SECRET);
	await expect(value).toBeVisible();

	// The value must fit inside the bordered row that holds it, at any length.
	const overflow = await value.evaluate((el) => {
		const row = el.closest("div.rounded-md")!;
		const v = el.getBoundingClientRect();
		const r = row.getBoundingClientRect();
		return { right: v.right - r.right, left: r.left - v.left };
	});
	expect(overflow.right).toBeLessThanOrEqual(0);
	expect(overflow.left).toBeLessThanOrEqual(0);
});
