/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Platform, PlatformProvider } from "../../context/PlatformContext";
import type { FileRecord } from "../../sync";
import type { FileTransferStatus } from "../../sync/transport/blob-sync";
import { AttachmentsDetail } from "./attachments";

// The line under an attachment that isn't on this device yet: what the file session says, asked
// once per look for every missing file of the entry.

const h = vi.hoisted(() => ({
	files: [] as FileRecord[],
	held: new Set<string>(),
	status: {} as Record<string, FileTransferStatus>,
	asked: [] as string[][],
}));

vi.mock("../../hooks/useVault", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../hooks/useVault")>()),
	useVaultState: () => ({
		files: h.files,
		canAttachFiles: true,
		canOpenFiles: true,
		canPickFiles: false,
	}),
	useVaultActions: () => actions,
}));

const actions = {
	hasFile: async (r: FileRecord) => h.held.has(r.hash),
	fileStatus: async (hashes: string[]) => {
		h.asked.push(hashes);
		return h.status;
	},
	describeFile: async () => ({ name: "passport.pdf", mime: "application/pdf" }),
	openFile: async () => {},
	detachFile: async () => {},
	attachFile: async () => {},
	pickFile: async () => null,
};

vi.mock("../hooks/usePopOut", () => ({
	usePopOut: () => ({ canPopOut: false, popOut: () => {} }),
}));

const platform = { target: "chromium", shell: {} } as unknown as Platform;

const record = (n: number): FileRecord =>
	({
		id: `f${n}`,
		entryId: "e1",
		hash: String(n).repeat(64),
		size: 1000,
		hlc: { wall: n, counter: 0, node: "x" },
	}) as unknown as FileRecord;

function mount() {
	return render(
		<I18nProvider i18n={i18n}>
			<PlatformProvider platform={platform}>
				<AttachmentsDetail entryId="e1" />
			</PlatformProvider>
		</I18nProvider>,
	);
}

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});

beforeEach(() => {
	h.files = [record(1)];
	h.held = new Set();
	h.status = {};
	h.asked = [];
});

afterEach(cleanup);

describe("a file not on this device yet", () => {
	const H = record(1).hash;

	it.each([
		[
			{ state: "downloading", from: "Laptop", received: 40, size: 100 },
			"Downloading from Laptop, 40%",
		],
		[{ state: "downloading", from: null, received: 1, size: 3 }, "Downloading, 33%"],
		[{ state: "queued", from: "Laptop" }, "Laptop has it. Coming next."],
		[{ state: "retrying", from: null }, "A device has it. Trying again shortly."],
		[{ state: "unreachable" }, "A device is online but can't connect to this one."],
		[{ state: "not-on-connected" }, "None of your connected devices has it yet."],
		[{ state: "desktop-only" }, "This browser gets files only from the Bramble desktop app."],
	] as [FileTransferStatus, string][])("says %o as %s", async (status, line) => {
		h.status = { [H]: status };
		mount();
		expect(await screen.findByText(line)).toBeTruthy();
	});

	it("never shows 100% before the file is whole", async () => {
		h.status = { [H]: { state: "downloading", from: null, received: 100, size: 100 } };
		mount();
		expect(await screen.findByText("Downloading, 99%")).toBeTruthy();
	});

	it("says only that it isn't here yet where there is no session to ask", async () => {
		mount();
		expect(
			await screen.findByText("Not on this device yet. Waiting for a device that has it."),
		).toBeTruthy();
	});

	it("is asked about in one request for every missing file, and only the missing ones", async () => {
		h.files = [record(1), record(2), record(3)];
		h.held = new Set([record(2).hash]);
		mount();
		await waitFor(() => expect(h.asked.length).toBeGreaterThan(0));
		expect(h.asked[0]).toEqual([record(1).hash, record(3).hash]);
	});

	it("isn't asked about at all once every file is here", async () => {
		h.held = new Set([H]);
		mount();
		expect(await screen.findByRole("button", { name: "Open attachment" })).toBeTruthy();
		expect(h.asked).toEqual([]);
	});
});
