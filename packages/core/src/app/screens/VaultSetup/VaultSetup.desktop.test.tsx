/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type Platform, PlatformProvider } from "../../../context/PlatformContext";
import { initialSetupMode } from "./types";
import { VaultSetup, type VaultSetupMode } from "./VaultSetup";

// Option B from the design: a card above today's tabs for people who already use the desktop app.

const h = vi.hoisted(() => ({
	/** The desktop's invite, once claimed; null before. */
	invite: null as string | null,
	/** What joining the desktop's vault reports. */
	joined: true,
	/** The symbols on screen, and whether this screen has said they match. */
	linking: null as unknown,
	awaitingApp: false,
	/** The desktop's vault is copying in. */
	joining: false,
	/** How often a card using the hook went away; the flow it runs dies with it. */
	unmounts: 0,
	/** The desktop sent no vault after a link. */
	claimFailed: false,
	error: null as string | null,
	calls: [] as string[],
}));

vi.mock("../../hooks/useDesktopLink", () => ({
	useDesktopLink: () => {
		useEffect(
			() => () => {
				h.unmounts++;
			},
			[],
		);
		return {
			busy: false,
			error: h.error,
			claimFailed: h.claimFailed,
			retryClaim: async () => {
				h.calls.push("retryClaim");
			},
			abandon: async () => {
				h.calls.push("abandon");
			},
			linking: h.linking,
			awaitingApp: h.awaitingApp,
			legacy: false,
			invite: h.invite,
			outcome: null,
			joining: h.joining,
			start: async () => {},
			accept: async () => h.joined,
		};
	},
}));

// No PopOutProvider here on purpose: OptionsApp, the setup screen's only host, has none.

const withLink = {
	desktopLink: { status: async () => ({ paired: false }) },
} as unknown as Platform;
const withoutLink = {} as unknown as Platform;

function mount(
	platform: Platform,
	mode: VaultSetupMode,
	onModeChange = vi.fn(),
	onDesktopLinked = vi.fn(),
) {
	render(
		<I18nProvider i18n={i18n}>
			<PlatformProvider platform={platform}>
				<VaultSetup
					mode={mode}
					onModeChange={onModeChange}
					onCreate={async () => {}}
					onDesktopLinked={onDesktopLinked}
				/>
			</PlatformProvider>
		</I18nProvider>,
	);
	return onModeChange;
}

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});
afterEach(cleanup);

describe("the desktop link on the setup screen", () => {
	it("offers to link the desktop app above the tabs", () => {
		const onModeChange = mount(withLink, "create");
		expect(screen.getByText(/using bramble desktop\?/i)).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: /^link$/i }));
		expect(onModeChange).toHaveBeenCalledWith("desktop");
	});

	it("is not offered where there is no desktop app to link", () => {
		mount(withoutLink, "create");
		expect(screen.queryByText(/using bramble desktop\?/i)).toBeNull();
	});

	it("shows the link card in desktop mode, with a way back to the tabs", () => {
		const onModeChange = mount(withLink, "desktop");
		expect(screen.getByText(/connect a browser/i)).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: /back/i }));
		expect(onModeChange).toHaveBeenCalledWith("create");
	});

	it("hands over to the host once the desktop's vault has arrived", async () => {
		// Without this the card fell back to its first step with the vault already here, as if
		// nothing had happened.
		h.invite = "invite";
		const onDesktopLinked = vi.fn();
		try {
			mount(withLink, "desktop", vi.fn(), onDesktopLinked);
			fireEvent.change(screen.getByLabelText(/master password/i), { target: { value: "pw" } });
			fireEvent.click(screen.getByRole("button", { name: /^link$/i }));
			await waitFor(() => expect(onDesktopLinked).toHaveBeenCalledOnce());
		} finally {
			h.invite = null;
		}
	});

	it("stays on the card when joining fails, where the error shows", async () => {
		h.invite = "invite";
		h.joined = false;
		const onDesktopLinked = vi.fn();
		try {
			mount(withLink, "desktop", vi.fn(), onDesktopLinked);
			fireEvent.change(screen.getByLabelText(/master password/i), { target: { value: "pw" } });
			fireEvent.click(screen.getByRole("button", { name: /^link$/i }));
			await new Promise((r) => setTimeout(r, 20));
			expect(onDesktopLinked).not.toHaveBeenCalled();
		} finally {
			h.invite = null;
			h.joined = true;
		}
	});

	it("says it is waiting for the desktop app once they match", () => {
		h.linking = { id: "L1", sas: { digits: "1234 5678 9012", emoji: [0, 1, 2, 3, 4, 5, 6] } };
		h.awaitingApp = true;
		try {
			mount(withLink, "desktop");
			expect(screen.getByText(/waiting for the desktop app/i)).toBeTruthy();
			expect(screen.queryByRole("button", { name: /they match/i })).toBeNull();
		} finally {
			h.linking = null;
			h.awaitingApp = false;
		}
	});

	it("keeps the link card while the desktop's vault copies in, so it can hand over after", () => {
		// The join swapped the screen for a connecting one, which unmounted the card mid-flow: it
		// never saw the new vault open, and the tab sat on the first step with the vault here.
		h.unmounts = 0;
		const view = (joining: boolean) => (
			<I18nProvider i18n={i18n}>
				<PlatformProvider platform={withLink}>
					<VaultSetup
						mode="desktop"
						onModeChange={vi.fn()}
						onCreate={async () => {}}
						joining={joining}
					/>
				</PlatformProvider>
			</I18nProvider>
		);
		const { rerender } = render(view(false));
		rerender(view(true));
		rerender(view(false));
		expect(h.unmounts).toBe(0);
	});

	it("shows the copy on the card while it runs", () => {
		h.joining = true;
		try {
			mount(withLink, "desktop");
			expect(screen.getByText(/copying your desktop app's vault/i)).toBeTruthy();
			expect(screen.getByText(/keep the desktop app open/i)).toBeTruthy();
			expect(screen.queryByRole("button", { name: /back/i })).toBeNull();
		} finally {
			h.joining = false;
		}
	});

	it("lets the link go when going back from the password step", async () => {
		// Back from here is leaving the pairing half made, so nothing is kept.
		h.invite = "invite";
		h.calls = [];
		try {
			const onModeChange = mount(withLink, "desktop");
			fireEvent.click(screen.getByRole("button", { name: /back/i }));
			await waitFor(() => expect(h.calls).toContain("abandon"));
			expect(onModeChange).toHaveBeenCalledWith("create");
		} finally {
			h.invite = null;
		}
	});

	it("offers Try again beside a claim that brought no vault", () => {
		h.claimFailed = true;
		h.error = "The desktop app didn't send its vault.";
		h.calls = [];
		try {
			mount(withLink, "desktop");
			fireEvent.click(screen.getByRole("button", { name: /try again/i }));
			expect(h.calls).toEqual(["retryClaim"]);
		} finally {
			h.claimFailed = false;
			h.error = null;
		}
	});

	it("comes back to the link card after the permission reload", () => {
		expect(initialSetupMode("?setup=desktop")).toBe("desktop");
		expect(initialSetupMode("")).toBe("create");
	});
});
