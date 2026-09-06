import { beforeEach, describe, expect, it, vi } from "vitest";
import { generatePassword } from "./password-gen";

// What the background answers GENERATE_PASSWORD with.
let response: unknown;
const safeRequest = vi.fn(async (_message: unknown) => response);
vi.mock("./lifecycle", () => ({ safeRequest: (m: unknown) => safeRequest(m) }));

/** A fresh copy of the module, so one test's held password can't serve another. */
async function load() {
	vi.resetModules();
	return import("./password-gen");
}

beforeEach(() => {
	response = { ok: true, data: { password: "refilled-from-the-background" } };
	safeRequest.mockClear();
});

describe("generatePassword", () => {
	it("returns a 20-character password", () => {
		expect(generatePassword()).toHaveLength(20);
	});

	it("draws only from the expected charset", () => {
		for (let i = 0; i < 50; i++) {
			expect(generatePassword()).toMatch(/^[A-Za-z0-9!@#$%^&*()_+\-=[\]{}|;:,.<>?]{20}$/);
		}
	});

	it("produces a different password each call", () => {
		expect(generatePassword()).not.toBe(generatePassword());
	});
});

describe("the password held for a suggestion", () => {
	it("offers what the background sent", async () => {
		const gen = await load();
		gen.holdGeneratedPassword("correct-horse-battery-staple");
		expect(gen.takeGeneratedPassword()).toBe("correct-horse-battery-staple");
	});

	// The suggestion is the point; a background that never answered costs the user its shape,
	// not its existence.
	it("falls back to a local password when nothing was sent", async () => {
		const gen = await load();
		expect(gen.takeGeneratedPassword()).toHaveLength(20);
	});

	it("keeps what it holds when a response carries nothing", async () => {
		const gen = await load();
		gen.holdGeneratedPassword("correct-horse-battery-staple");
		// An older background, or a page with no login field, sends no password. That is not a
		// reason to throw away a good one.
		gen.holdGeneratedPassword(undefined);
		gen.holdGeneratedPassword("");
		gen.holdGeneratedPassword(42);
		expect(gen.takeGeneratedPassword()).toBe("correct-horse-battery-staple");
	});

	// A page can have a second signup field; asking on the way out means it is served from the
	// user's settings too rather than falling back.
	it("asks for a replacement once one is spent", async () => {
		const gen = await load();
		gen.holdGeneratedPassword("correct-horse-battery-staple");
		gen.takeGeneratedPassword();
		expect(safeRequest).toHaveBeenCalledWith({ type: "GENERATE_PASSWORD" });

		await vi.waitFor(() =>
			expect(gen.takeGeneratedPassword()).toBe("refilled-from-the-background"),
		);
	});

	it("does not ask for a replacement it never spent", async () => {
		const gen = await load();
		expect(gen.takeGeneratedPassword()).toHaveLength(20);
		expect(safeRequest).not.toHaveBeenCalled();
	});
});

describe("requesting a fresh password", () => {
	it("returns what the background generated", async () => {
		const gen = await load();
		await expect(gen.requestGeneratedPassword()).resolves.toBe("refilled-from-the-background");
		expect(safeRequest).toHaveBeenCalledWith({ type: "GENERATE_PASSWORD" });
	});

	it("falls back locally when the request fails or answers with junk", async () => {
		const gen = await load();
		for (const answer of [undefined, { ok: false }, { ok: true }, { ok: true, data: {} }]) {
			response = answer;
			expect(await gen.requestGeneratedPassword()).toHaveLength(20);
		}
	});
});
