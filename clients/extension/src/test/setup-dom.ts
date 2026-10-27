// Vitest setup for the jsdom test files. The detection helpers memoize whether
// the page has any open shadow root (see detection.ts); in the browser the
// MutationObserver drops that memo, but a test rebuilding document.body between
// cases has no such signal, so a no-shadow case would leave the next
// shadow-DOM case reading a stale "no". Reset it around every test.

import { beforeEach } from "vitest";
import { resetDomScanForTest } from "../content/detection";

beforeEach(() => {
	resetDomScanForTest();
});
