import { expect, test } from "./fixtures";
import { backgroundWorker, createVault, expectUnlocked, lock, openPopup, unlock } from "./helpers";

// Increment 3: the common path through the real UI - create a vault, then lock and unlock it.
test("create a vault, then lock and unlock it", async ({ context, extensionId }) => {
	const setup = await context.newPage();
	await createVault(setup, extensionId);

	const popup = await context.newPage();
	await openPopup(popup, extensionId);
	// Creation cached the VEK in session storage, so the popup opens unlocked.
	await expectUnlocked(popup);
	await expect(popup.getByText(/Your vault is empty/i)).toBeVisible();

	await lock(popup);
	// The unlock screen names the vault it's unlocking, in the top-left.
	await expect(popup.getByTestId("active-vault-label")).toHaveText("Vault 1");
	// Wrong password is rejected.
	await popup.locator('input[type="password"]').first().fill("not-the-password");
	await popup.getByRole("button", { name: "Unlock Vault" }).click();
	await expect(popup.getByText(/Incorrect master password/i)).toBeVisible();

	// The real password unlocks, and the header names the (only) vault.
	await unlock(popup);
	await expect(popup.getByTestId("active-vault-label")).toHaveText("Vault 1");
});

// Regression: an unlocked vault must land on its home screen, not the vault picker. Creating a
// second vault leaves it active + unlocked, so a freshly opened popup opens straight on it.
test("a newly created second vault opens directly, not the picker", async ({
	context,
	extensionId,
}) => {
	const s1 = await context.newPage();
	await createVault(s1, extensionId);
	const s2 = await context.newPage();
	await createVault(s2, extensionId);

	const popup = await context.newPage();
	await openPopup(popup, extensionId);
	await expectUnlocked(popup);
	await expect(popup.getByRole("heading", { name: /Choose a vault/i })).toHaveCount(0);
	// The header names the open vault when more than one exists (the second is "Vault 2").
	await expect(popup.getByTestId("active-vault-label")).toHaveText("Vault 2");
});

// The outlined TextField draws its border with a fieldset/legend, so the label gap is a real
// notch. The notch used to key off the group's :focus-within while the label keyed off the
// input, and the password reveal button lives in that same group - so focusing the eye notched
// the border open with no label in it (a visible cut in the border). Both must agree.
test("the reveal button doesn't leave a gap in the master-password border", async ({
	context,
	extensionId,
}) => {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);
	await lock(popup);

	// notch open <-> label floated, read off real layout (CSS-driven, so jsdom can't see it).
	const state = () =>
		popup.evaluate(() => {
			const input = document.querySelector<HTMLInputElement>(
				'input[type="password"], input[type="text"]',
			);
			const group = input?.closest(".group") as HTMLElement;
			const legend = group.querySelector("legend") as HTMLElement;
			const label = group.querySelector("label") as HTMLElement;
			return {
				notchOpen: legend.getBoundingClientRect().width > 4,
				labelFloated:
					Math.abs(label.getBoundingClientRect().top - group.getBoundingClientRect().top) < 8,
			};
		});

	// Poll: the label/notch animate (150ms), so assert the settled state.
	await popup.locator('input[type="password"]').first().click();
	await expect.poll(state).toEqual({ notchOpen: true, labelFloated: true });

	// Focus moves to the eye, off the (empty) input: the notch must close with the label.
	await popup.getByRole("button", { name: /Show password/i }).click();
	await expect.poll(state).toEqual({ notchOpen: false, labelFloated: false });

	// With a value, both stay on even while the eye holds focus.
	await popup.locator('input[type="text"], input[type="password"]').first().fill("hunter2");
	await popup
		.getByRole("button", { name: /password/i })
		.first()
		.click();
	expect(await state()).toEqual({ notchOpen: true, labelFloated: true });
});

// A detached pop-out lives in its own popup-type window whose only tab is the extension page,
// so `tabs.query({currentWindow:true})` finds no web page and every site-aware feature (the
// current-site float-to-top, the new-entry URL prefill) silently went dead there - which also
// made a just-saved login impossible to spot in a long list. It must fall back to the active
// tab of a normal window.
test("a detached pop-out still floats the current site to the top", async ({
	context,
	extensionId,
}) => {
	const popup = await context.newPage();
	await createVault(popup, extensionId);
	await openPopup(popup, extensionId);

	const addLogin = async (name: string, url: string) => {
		await popup.getByRole("button", { name: /Add New/i }).click();
		await popup.getByRole("button", { name: /Add a new login/i }).click();
		await popup.getByLabel("Name", { exact: true }).fill(name);
		await popup.getByRole("button", { name: /Add URL/i }).click();
		await popup.getByLabel("Website URL", { exact: true }).fill(url);
		await popup.getByLabel("Username or email", { exact: true }).fill("user@example.com");
		await popup.getByLabel("Password", { exact: true }).fill("pw-123456");
		await popup.getByRole("button", { name: /Save Login/i }).click();
		await expect(popup.getByText(name)).toBeVisible();
	};
	// "Zebra" sorts last under Name A-Z, so it can only lead by matching the current tab.
	await addLogin("Aaa Other", "https://other.test");
	await addLogin("Zebra Example", "https://example.com");

	// The page the user is actually on, in a normal browser window.
	const site = await context.newPage();
	await site
		.context()
		.route(/example\.com/, (r) =>
			r.fulfill({ body: "<h1>site</h1>", headers: { "content-type": "text/html" } }),
		);
	await site.goto("https://example.com/");
	await site.bringToFront();

	// Pop out exactly as the background does (windows.create, popup type).
	const sw = await backgroundWorker(context);
	await sw.evaluate(async (id) => {
		await chrome.windows.create({
			url: `chrome-extension://${id}/popup.html?detached=1`,
			type: "popup",
			focused: true,
			width: 500,
			height: 600,
		});
	}, extensionId);

	await expect
		.poll(
			async () => {
				const pop = context.pages().find((p) => p.url().includes("detached=1"));
				if (!pop) return null;
				return pop.evaluate(() =>
					Array.from(document.querySelectorAll("li, [role='listitem'], button"))
						.map((e) => (e.textContent ?? "").trim())
						.filter((t) => t.includes("Zebra Example") || t.includes("Aaa Other"))
						.map((t) => (t.includes("Zebra") ? "Zebra" : "Aaa"))
						.slice(0, 2),
				);
			},
			{ timeout: 15_000 },
		)
		.toEqual(["Zebra", "Aaa"]);
});
