/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { type Platform, PlatformProvider } from "../../context/PlatformContext";
import { RecoveryCodeDisplay } from "./RecoveryCodeDisplay";

// The saved file is the only copy of a code the app never persists, so what it is called and what
// it says are user-visible surface. Both once carried a retired product name (github issue: the
// download was `titanpass-recovery-code.txt`), which is why they are pinned here.

const saved: { name: string; body: string }[] = [];

const platform = {
	shell: {
		appName: "Bramble",
		exportBytes: async (name: string, bytes: Uint8Array) => {
			saved.push({ name, body: new TextDecoder().decode(bytes) });
		},
	},
} as unknown as Platform;

const mount = () =>
	render(
		<I18nProvider i18n={i18n}>
			<PlatformProvider platform={platform}>
				<RecoveryCodeDisplay code="ABCD-EFGH-IJKL" onContinue={vi.fn()} />
			</PlatformProvider>
		</I18nProvider>,
	);

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});

afterEach(() => {
	cleanup();
	saved.length = 0;
});

it("saves the code under the app's own name, not a retired one", async () => {
	mount();
	fireEvent.click(screen.getByRole("button", { name: /download/i }));

	await waitFor(() => expect(saved).toHaveLength(1));
	const file = saved[0] as { name: string; body: string };
	expect(file.name).toBe("bramble-recovery-code.txt");
	expect(file.body).toContain("Bramble recovery code");
	expect(file.body).toContain("ABCD-EFGH-IJKL");
	expect(`${file.name}\n${file.body}`.toLowerCase()).not.toContain("titanpass");
});
