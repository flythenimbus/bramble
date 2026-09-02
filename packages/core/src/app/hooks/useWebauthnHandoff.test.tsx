/** @vitest-environment happy-dom */
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Platform, PlatformProvider } from "../../context/PlatformContext";
import { useWebauthnHandoff, type WebauthnHandoff } from "./useWebauthnHandoff";

// Firefox tears its panel popup down when the OS passkey dialog takes focus, killing the
// ceremony before the dialog renders: no prompt, no error, and the console goes with the
// document. So the ceremony is handed to the detached window instead. The rules that decide
// WHERE it runs are the whole fix, and e2e cannot check them - Playwright loads popup.html as a
// tab, which never has the popup's lifetime. See docs/security-keys.md.

const h = vi.hoisted(() => ({
	popOut: vi.fn(),
	draft: undefined as unknown,
}));

vi.mock("./usePopOut", () => ({
	usePopOut: () => ({
		popOut: h.popOut,
		takeInitialDraft: () => {
			const d = h.draft;
			h.draft = undefined; // one-shot, as the real one is
			return d;
		},
		canPopOut: true,
		registerDraftGetter: () => {},
	}),
}));

function Probe({
	onResume,
	ready = true,
}: {
	onResume?: (i: WebauthnHandoff) => void;
	ready?: boolean;
}) {
	const { mustHandOff, handOff } = useWebauthnHandoff(onResume, ready);
	return (
		<button type="button" data-must={mustHandOff} onClick={() => handOff({ webauthn: "unlock" })}>
			go
		</button>
	);
}

function mount(
	target: string,
	detached = false,
	onResume?: (i: WebauthnHandoff) => void,
	ready = true,
) {
	const platform = { target, shell: { isDetached: () => detached } } as unknown as Platform;
	const tree = (r: boolean) => (
		<PlatformProvider platform={platform}>
			<Probe onResume={onResume} ready={r} />
		</PlatformProvider>
	);
	const utils = render(tree(ready));
	return { ...utils, setReady: (r: boolean) => utils.rerender(tree(r)) };
}

const mustHandOff = () => document.querySelector("button")?.dataset.must === "true";

beforeEach(() => {
	h.popOut.mockClear();
	h.draft = undefined;
});
afterEach(cleanup);

describe("where a webauthn ceremony is allowed to run", () => {
	it("hands off from Firefox's attached popup", () => {
		mount("firefox");
		expect(mustHandOff()).toBe(true);
	});

	it("runs in place on Chromium, whose popup survives the dialog", () => {
		// Measured on a device: Chromium registers and unlocks from the attached popup with no
		// trouble, so sending its users to a second window would be a regression.
		mount("chromium");
		expect(mustHandOff()).toBe(false);
	});

	it("runs in place once already detached, or it would pop out forever", () => {
		mount("firefox", true);
		expect(mustHandOff()).toBe(false);
	});

	it("passes the intent to the window it opens", () => {
		mount("firefox");
		document.querySelector("button")?.click();
		expect(h.popOut).toHaveBeenCalledWith({ webauthn: "unlock" });
	});
});

describe("resuming a handed-over ceremony", () => {
	it("fires once for the intent it was given", () => {
		const onResume = vi.fn();
		h.draft = { webauthn: "register", kind: "platform", label: "MacBook" };
		mount("firefox", true, onResume);

		expect(onResume).toHaveBeenCalledOnce();
		expect(onResume).toHaveBeenCalledWith({
			webauthn: "register",
			kind: "platform",
			label: "MacBook",
		});
	});

	it("ignores an ordinary form draft, which is what usually travels this channel", () => {
		const onResume = vi.fn();
		h.draft = { title: "some entry", password: "hunter2" };
		mount("firefox", true, onResume);

		expect(onResume).not.toHaveBeenCalled();
	});

	it("rejects an unknown key kind rather than passing it to the ceremony", () => {
		const onResume = vi.fn();
		h.draft = { webauthn: "register", kind: "fingerprint", label: "x" };
		mount("firefox", true, onResume);

		expect(onResume).not.toHaveBeenCalled();
	});

	it("tolerates a missing label, so a nameless key still registers", () => {
		const onResume = vi.fn();
		h.draft = { webauthn: "register", kind: "securityKey" };
		mount("firefox", true, onResume);

		expect(onResume).toHaveBeenCalledWith({
			webauthn: "register",
			kind: "securityKey",
			label: "",
		});
	});

	it("does nothing when the window was opened by hand", () => {
		const onResume = vi.fn();
		mount("firefox", true, onResume);

		expect(onResume).not.toHaveBeenCalled();
	});
});

describe("waiting until the screen can service it", () => {
	it("does not resume before the vault is ready", () => {
		// Finishing an unlock records the active vault first, and the registry loads async. Firing
		// on a bare mount sets it to null, and the unwrap comes back "vault locked" - which is
		// exactly what a device reported: the prompt appeared, the tap worked, the unlock did not.
		const onResume = vi.fn();
		h.draft = { webauthn: "unlock" };
		mount("firefox", true, onResume, false);

		expect(onResume).not.toHaveBeenCalled();
	});

	it("resumes once ready, without having consumed the intent meanwhile", () => {
		const onResume = vi.fn();
		h.draft = { webauthn: "unlock" };
		const { setReady } = mount("firefox", true, onResume, false);

		setReady(true);

		expect(onResume).toHaveBeenCalledOnce();
		expect(onResume).toHaveBeenCalledWith({ webauthn: "unlock" });
	});

	it("still fires only once when readiness flaps", () => {
		const onResume = vi.fn();
		h.draft = { webauthn: "unlock" };
		const { setReady } = mount("firefox", true, onResume, false);

		setReady(true);
		setReady(false);
		setReady(true);

		expect(onResume).toHaveBeenCalledOnce();
	});
});
