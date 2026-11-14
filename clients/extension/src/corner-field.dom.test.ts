/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// The save card's Username box. It is an extension-origin document so that nothing typed in it
// crosses the page, and it talks to the card over extension messaging only.

type Sent = { type: string; payload: { id: string; op: string; value?: string; flush?: number } };
type Reply = { ok: boolean; data?: { value: string } } | undefined;

let sent: Sent[] = [];
let answerOpen: (reply: Reply) => void = () => {};
let input: HTMLInputElement;
let serial = 0;

/** Load a fresh copy of the frame's script, as its own document would. */
async function load(): Promise<string> {
	const id = `field-${++serial}`;
	vi.resetModules();
	sent = [];
	document.body.innerHTML = "<input />";
	input = document.querySelector("input") as HTMLInputElement;
	history.replaceState(null, "", `/corner-field.html?id=${id}`);
	vi.stubGlobal("chrome", {
		i18n: { getMessage: (key: string) => `[${key}]` },
		runtime: {
			sendMessage: (message: Sent) => {
				// Earlier copies still listen on this window; only this one counts.
				if (message.payload.id === id) sent.push(message);
				if (message.payload.op !== "open") return Promise.resolve({ ok: true });
				return new Promise<Reply>((resolve) => {
					if (message.payload.id === id) answerOpen = resolve;
				});
			},
		},
	});
	await import("./corner-field");
	return id;
}

const settle = () => new Promise((r) => setTimeout(r, 0));

function flushFrom(source: unknown, n: unknown): void {
	const e = new MessageEvent("message", { data: { type: "CORNER_FIELD_FLUSH", n } });
	Object.defineProperty(e, "source", { value: source });
	window.dispatchEvent(e);
}

function type(value: string): void {
	input.value = value;
	input.dispatchEvent(new Event("input"));
}

beforeEach(() => {
	vi.unstubAllGlobals();
});

describe("corner-field", () => {
	it("asks the card for its text, shows it, and reports in", async () => {
		const id = await load();
		expect(sent).toEqual([{ type: "CORNER_FIELD", payload: { id, op: "open" } }]);

		answerOpen({ ok: true, data: { value: "alice" } });
		await settle();
		expect(input.value).toBe("alice");
		expect(sent[1]).toEqual({ type: "CORNER_FIELD", payload: { id, op: "value", value: "alice" } });
	});

	it("stays silent for a card that does not know it", async () => {
		await load();
		answerOpen({ ok: false });
		await settle();
		expect(sent).toHaveLength(1);

		await load();
		answerOpen(undefined);
		await settle();
		expect(sent).toHaveLength(1);
	});

	it("reports every edit", async () => {
		const id = await load();
		answerOpen({ ok: true, data: { value: "alice" } });
		await settle();

		type("carol");
		expect(sent.at(-1)).toEqual({
			type: "CORNER_FIELD",
			payload: { id, op: "value", value: "carol" },
		});
	});

	it("keeps what was typed while the first answer was on its way", async () => {
		await load();
		type("c");
		answerOpen({ ok: true, data: { value: "alice" } });
		await settle();
		expect(input.value).toBe("c");
		expect(sent.at(-1)?.payload).toMatchObject({ op: "value", value: "c" });
	});

	it("answers the card's flush with what it holds", async () => {
		const id = await load();
		answerOpen({ ok: true, data: { value: "alice" } });
		await settle();
		input.value = "carol";

		flushFrom(window.parent, 7);
		expect(sent.at(-1)).toEqual({
			type: "CORNER_FIELD",
			payload: { id, op: "value", value: "carol", flush: 7 },
		});
	});

	it("ignores a flush that is not from its parent, or not a count", async () => {
		await load();
		answerOpen({ ok: true, data: { value: "alice" } });
		await settle();
		const before = sent.length;

		flushFrom(null, 7);
		flushFrom({}, 7);
		flushFrom(window.parent, "7");
		expect(sent).toHaveLength(before);
	});

	it("stays quiet once the extension is gone from under it", async () => {
		await load();
		answerOpen({ ok: true, data: { value: "alice" } });
		await settle();
		const gone = globalThis as unknown as { chrome: { runtime: { sendMessage: unknown } } };
		gone.chrome.runtime.sendMessage = () => {
			throw new Error("Extension context invalidated.");
		};
		// A listener's throw surfaces as an error event, not at the dispatch.
		const errors: unknown[] = [];
		const onError = (e: ErrorEvent) => {
			errors.push(e.error);
			e.preventDefault();
		};
		window.addEventListener("error", onError);
		type("carol");
		flushFrom(window.parent, 3);
		window.removeEventListener("error", onError);
		expect(errors).toEqual([]);
	});

	it("names the box for a screen reader", async () => {
		await load();
		expect(input.getAttribute("aria-label")).toBe("[fieldUsername]");
	});
});
