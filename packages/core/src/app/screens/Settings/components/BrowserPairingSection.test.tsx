/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type Platform, PlatformProvider } from "../../../../context/PlatformContext";
import { BrowserPairingSection } from "./BrowserPairingSection";

// The desktop's half of linking a browser: one emoji comparison, confirmed here and in the
// browser. No code: an extension that predates the emoji cannot link to this app.

const h = vi.hoisted(() => ({
	calls: [] as string[],
	onPending: null as ((p: { sasHashB64: string; label: string }) => void) | null,
	onDone: null as ((paired: boolean) => void) | null,
	summaries: [] as unknown[],
	onSyncEvent: null as ((e: { kind: string }) => void) | null,
	listed: [] as unknown[],
	/** Arming the invite waits on this, as deriving the admission key does in the app. */
	armed: Promise.resolve() as Promise<void>,
	/** How many times preparing the invite fails before it works. */
	inviteFailures: 0,
}));

vi.mock("../../../../hooks/useVaultRegistry", () => ({
	useVaultRegistry: () => ({ vaults: [{ id: "v1", label: "Home", createdAt: 1 }], activeId: "v1" }),
}));

vi.mock("../../../../hooks/useVault", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../../hooks/useVault")>()),
	useVault: () => ({ hasPasswordSlot: true, entries: [{ id: "a" }, { id: "b" }], files: [] }),
	useVaultActions: () => ({
		verifyMasterPassword: async () => true,
		inviteDevice: async () => {
			if (h.inviteFailures > 0) {
				h.inviteFailures--;
				throw new Error("The invite could not be prepared.");
			}
			return "invite";
		},
	}),
}));

const pairing = {
	list: async () => h.listed,
	identity: async () => "id",
	forget: async () => true,
	armSyncInvite: async () => {
		h.calls.push("arming");
		await h.armed;
	},
	clearSyncInvite: async () => {
		h.calls.push("clearInvite");
	},
	beginLinkWindow: async () => {
		h.calls.push("beginWindow");
	},
	cancelLinkWindow: async () => {
		h.calls.push("cancelWindow");
	},
	answerLink: async (approved: boolean) => {
		h.calls.push(`answer:${approved}`);
	},
	onLinkPending: (cb: (p: { sasHashB64: string; label: string }) => void) => {
		h.onPending = cb;
		return () => {};
	},
	setVaultSummary: async (summary: unknown) => {
		h.summaries.push(summary);
	},
	onLinkDone: (cb: (paired: boolean) => void) => {
		h.onDone = cb;
		return () => {};
	},
};

const platform = {
	target: "desktop",
	storage: { getMeta: async () => undefined },
	shell: {
		onSyncEvent: (cb: (e: { kind: string }) => void) => {
			h.onSyncEvent = cb;
			return () => {};
		},
	},
	pairing,
} as unknown as Platform;

const HASH = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";

function mount() {
	return render(
		<I18nProvider i18n={i18n}>
			<PlatformProvider platform={platform}>
				<BrowserPairingSection />
			</PlatformProvider>
		</I18nProvider>,
	);
}

async function connect() {
	mount();
	fireEvent.click(await screen.findByRole("button", { name: /^connect$/i }));
	fireEvent.change(screen.getByLabelText(/master password/i), { target: { value: "pw" } });
	fireEvent.click(screen.getByRole("button", { name: /^continue$/i }));
	await waitFor(() => expect(h.calls).toContain("beginWindow"));
}

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});

afterEach(() => {
	cleanup();
	h.calls.length = 0;
	h.onPending = null;
	h.onDone = null;
	h.summaries.length = 0;
	h.listed = [];
	h.onSyncEvent = null;
	h.armed = Promise.resolve();
	h.inviteFailures = 0;
});

describe("the list of linked browsers", () => {
	it("drops a browser as soon as the sync group removes it", async () => {
		h.listed = [{ publicKey: "pk", label: "Chrome on Mac", pairedAt: 1 }];
		mount();
		expect(await screen.findByText("Chrome on Mac")).toBeTruthy();
		h.listed = [];
		act(() => h.onSyncEvent?.({ kind: "roster" }));
		await waitFor(() => expect(screen.queryByText("Chrome on Mac")).toBeNull());
	});
});

describe("connecting a browser by emoji", () => {
	it("opens the link window and offers no code for an older extension", async () => {
		await connect();
		expect(screen.queryByRole("button", { name: /older extension/i })).toBeNull();
		expect(screen.getByText(/in the bramble extension, press link/i)).toBeTruthy();
	});

	it("says to press Link only once this vault's invite is ready", async () => {
		// A browser that linked sooner got the link and never the vault.
		let ready!: () => void;
		h.armed = new Promise<void>((resolve) => {
			ready = resolve;
		});
		mount();
		fireEvent.click(await screen.findByRole("button", { name: /^connect$/i }));
		fireEvent.change(screen.getByLabelText(/master password/i), { target: { value: "pw" } });
		fireEvent.click(screen.getByRole("button", { name: /^continue$/i }));
		await waitFor(() => expect(h.calls).toContain("arming"));
		expect(screen.queryByText(/press link/i)).toBeNull();

		ready();
		expect(await screen.findByText(/in the bramble extension, press link/i)).toBeTruthy();
	});

	it("opens no link window when the invite cannot be prepared, and Continue tries again", async () => {
		// A link without the invite would be a pairing with no vault in the browser.
		h.inviteFailures = 1;
		mount();
		fireEvent.click(await screen.findByRole("button", { name: /^connect$/i }));
		fireEvent.change(screen.getByLabelText(/master password/i), { target: { value: "pw" } });
		fireEvent.click(screen.getByRole("button", { name: /^continue$/i }));

		expect(await screen.findByText(/the invite could not be prepared/i)).toBeTruthy();
		expect(h.calls).toContain("cancelWindow");
		expect(screen.queryByText(/press link/i)).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: /^continue$/i }));
		expect(await screen.findByText(/in the bramble extension, press link/i)).toBeTruthy();
	});

	it("keeps the password for the retry", async () => {
		h.inviteFailures = 1;
		mount();
		fireEvent.click(await screen.findByRole("button", { name: /^connect$/i }));
		fireEvent.change(screen.getByLabelText(/master password/i), { target: { value: "pw" } });
		fireEvent.click(screen.getByRole("button", { name: /^continue$/i }));

		await screen.findByText(/the invite could not be prepared/i);
		expect((screen.getByLabelText(/master password/i) as HTMLInputElement).value).toBe("pw");
	});

	it("shows the browser's emoji and approves when they match", async () => {
		await connect();
		h.onPending?.({ sasHashB64: HASH, label: "Chrome on Mac" });
		expect(await screen.findByText(/chrome on mac/i)).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: /^approve$/i }));
		await waitFor(() => expect(h.calls).toContain("answer:true"));
	});

	it("waits for the browser once approved, rather than looking unchanged", async () => {
		await connect();
		h.onPending?.({ sasHashB64: HASH, label: "Chrome on Mac" });
		fireEvent.click(await screen.findByRole("button", { name: /^approve$/i }));
		expect(await screen.findByText(/waiting for chrome on mac/i)).toBeTruthy();
		expect(screen.queryByRole("button", { name: /^approve$/i })).toBeNull();
	});

	it("waits for the browser to finish once both screens confirm, and Cancel lets it go", async () => {
		// The browser is listed only once it holds the vault; until then this window has closed
		// to new links, so it must not go back to asking for one.
		await connect();
		h.onPending?.({ sasHashB64: HASH, label: "Chrome on Mac" });
		fireEvent.click(await screen.findByRole("button", { name: /^approve$/i }));
		act(() => h.onDone?.(true));

		expect(await screen.findByText(/waiting for chrome on mac to finish/i)).toBeTruthy();
		expect(screen.queryByText(/press link/i)).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
		await waitFor(() => expect(h.calls).toContain("clearInvite"));
	});

	it("stops waiting, and says so, when the browser goes away before it finishes", async () => {
		await connect();
		h.onPending?.({ sasHashB64: HASH, label: "Chrome on Mac" });
		fireEvent.click(await screen.findByRole("button", { name: /^approve$/i }));
		act(() => h.onDone?.(true));
		await screen.findByText(/waiting for chrome on mac to finish/i);

		act(() => h.onDone?.(false));

		await waitFor(() => expect(screen.queryByText(/waiting for chrome on mac/i)).toBeNull());
		expect(screen.getByText(/the browser was not linked/i)).toBeTruthy();
		expect(h.calls).toContain("clearInvite");
	});

	it("keeps waiting past the link window, and closes when the pending link would have expired", async () => {
		// The window to start a link is 3 minutes; the link it started has 5 to finish.
		vi.useFakeTimers({ shouldAdvanceTime: true });
		try {
			await connect();
			h.onPending?.({ sasHashB64: HASH, label: "Chrome on Mac" });
			fireEvent.click(await screen.findByRole("button", { name: /^approve$/i }));
			act(() => h.onDone?.(true));
			await screen.findByText(/waiting for chrome on mac to finish/i);

			act(() => vi.advanceTimersByTime(181_000));
			expect(screen.getByText(/waiting for chrome on mac to finish/i)).toBeTruthy();

			act(() => vi.advanceTimersByTime(120_000));
			await waitFor(() => expect(screen.queryByText(/waiting for chrome on mac/i)).toBeNull());
			expect(h.calls).toContain("clearInvite");
		} finally {
			vi.useRealTimers();
		}
	});

	it("refuses when they do not match", async () => {
		await connect();
		h.onPending?.({ sasHashB64: HASH, label: "Chrome on Mac" });
		fireEvent.click(await screen.findByRole("button", { name: /don't match/i }));
		await waitFor(() => expect(h.calls).toContain("answer:false"));
	});

	it("tells the linking browser what this vault holds, and stops on cancel", async () => {
		await connect();
		await waitFor(() =>
			expect(h.summaries).toContainEqual({ name: "Home", empty: false, entries: 2 }),
		);
		fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
		await waitFor(() => expect(h.summaries.at(-1)).toBeNull());
	});

	it("closes the link window and drops the invite on cancel", async () => {
		await connect();
		fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
		await waitFor(() =>
			expect(h.calls).toEqual(expect.arrayContaining(["cancelWindow", "clearInvite"])),
		);
	});
});
