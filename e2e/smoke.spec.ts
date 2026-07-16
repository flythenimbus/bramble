import { expect, test } from "@playwright/test";

// Increment 1: prove the Playwright runner and config load and execute. No browser here;
// the extension-loading fixture arrives in extension.spec.ts.
test("playwright runner is wired up", () => {
	expect(1 + 1).toBe(2);
});
