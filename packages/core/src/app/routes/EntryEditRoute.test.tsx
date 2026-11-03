/** @vitest-environment happy-dom */
import { cleanup, render } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EntryEditRoute } from "./EntryEditRoute";

// The route's part of "an edit-form save supersedes the version it opened": it captures the
// version once, carries it through a pop-out, and hands it to the save. The form is stubbed.

interface FormProps {
	onSave: (data: unknown) => Promise<void>;
	onBack: () => void;
	draftValues?: unknown;
	registerDraft?: (getter: (() => unknown) | null) => void;
}

const h = vi.hoisted(() => ({
	entries: [] as unknown[],
	openVersion: vi.fn(),
	updateEntry: vi.fn(async (..._args: unknown[]) => {}),
	initialDraft: undefined as unknown,
	draftGetter: null as null | (() => unknown),
	form: null as null | FormProps,
	back: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
	useNavigate: () => () => {},
	useParams: () => ({ entryId: "e" }),
}));
vi.mock("../../hooks/useVault", () => ({
	useVault: () => ({ entries: h.entries, updateEntry: h.updateEntry, openVersion: h.openVersion }),
}));
vi.mock("../../hooks/usePrefs", () => ({ usePrefs: () => ({ prefs: {} }) }));
vi.mock("../hooks/usePopOut", () => ({
	usePopOut: () => ({
		registerDraftGetter: (getter: (() => unknown) | null) => {
			h.draftGetter = getter;
		},
		takeInitialDraft: () => h.initialDraft,
	}),
}));
vi.mock("../hooks/useRouteBack", () => ({ useRouteBack: () => h.back }));
vi.mock("../pending-totp", () => ({ takeTotpForEntry: () => undefined }));
vi.mock("../entry-modes", () => ({ getEntryMode: () => ({ label: "Login" }) }));
vi.mock("../screens/CreateEntry/EntryForm", () => ({
	EntryForm: (props: FormProps) => {
		h.form = props;
		useEffect(() => {
			props.registerDraft?.(() => ({ name: "typed" }));
			return () => props.registerDraft?.(null);
		}, [props.registerDraft]);
		return null;
	},
}));

const login = (password: string) => ({
	id: "e",
	type: "login",
	name: "A",
	urls: [],
	username: "u",
	password,
});
const version = (wall: number, password: string) => ({
	hlc: { wall, counter: 0, node: "laptop" },
	vv: { laptop: { wall, counter: 0, node: "laptop" } },
	data: login(password),
});

afterEach(cleanup);
beforeEach(() => {
	vi.clearAllMocks();
	h.initialDraft = undefined;
	h.draftGetter = null;
});

it("saving passes the version the form opened, even after another one is displayed", async () => {
	const opened = version(1000, "p");
	h.entries = [login("p")];
	h.openVersion.mockReturnValue(opened);
	const { rerender } = render(<EntryEditRoute />);
	h.entries = [login("theirs")];
	h.openVersion.mockReturnValue(version(2000, "theirs"));
	rerender(<EntryEditRoute />);
	await h.form!.onSave(login("mine"));
	expect(h.updateEntry).toHaveBeenCalledWith(
		"e",
		expect.objectContaining({ password: "mine" }),
		opened,
	);
	expect(h.draftGetter!()).toEqual({ values: { name: "typed" }, opened });
});

it("a popped-out form keeps the version the original window opened", async () => {
	const original = version(1000, "p");
	h.entries = [login("theirs")];
	h.openVersion.mockReturnValue(version(2000, "theirs"));
	h.initialDraft = { values: { name: "typed" }, opened: original };
	render(<EntryEditRoute />);
	expect(h.form!.draftValues).toEqual({ name: "typed" });
	await h.form!.onSave(login("mine"));
	expect(h.updateEntry).toHaveBeenCalledWith("e", expect.anything(), original);
});

// A restored popup route can render before the vault's entries load.
it("a form that mounts before the entries load records the version it then opens", async () => {
	const opened = version(1000, "p");
	h.entries = [];
	h.openVersion.mockReturnValue(undefined);
	const { rerender } = render(<EntryEditRoute />);
	h.entries = [login("p")];
	h.openVersion.mockReturnValue(opened);
	rerender(<EntryEditRoute />);
	await h.form!.onSave(login("mine"));
	expect(h.updateEntry).toHaveBeenCalledWith("e", expect.anything(), opened);
});

// The form edits its own fields only; everything else the opened version holds (archived state,
// a field a newer build added) stays, and a field the form cleared stays cleared.
it("saving keeps what the form doesn't edit, and what it cleared stays cleared", async () => {
	const opened = version(1000, "p");
	const data = { ...opened.data, notes: "old", archivedAt: 5, futureField: { x: 1 } };
	h.entries = [data];
	h.openVersion.mockReturnValue({ ...opened, data });
	render(<EntryEditRoute />);
	await h.form!.onSave({ ...login("mine"), notes: undefined });
	const saved = h.updateEntry.mock.calls[0]?.[1] as Record<string, unknown>;
	expect(saved).toMatchObject({ password: "mine", archivedAt: 5, futureField: { x: 1 } });
	expect(saved.notes).toBeUndefined();
});

// #150: pushing the detail after a save left the form in history, so back from the detail
// reopened it. Cancel and Save leave the way the header's back does.
it("cancel and save leave through the route's back, not a fresh push", () => {
	h.entries = [login("p")];
	render(<EntryEditRoute />);
	expect(h.form!.onBack).toBe(h.back);
});
