// The save card's Username box. An extension-origin document, so nothing typed here crosses the
// page; it reaches the card over extension messaging only. See docs/autofill.md ("Typing on the
// card"). Self-contained so the bundle stays flat.

// A module, so these names stay out of the other entries' global scope.
export {};

type Reply = { ok?: boolean; data?: { value?: string } } | undefined;
type Api = {
	i18n: { getMessage(key: string): string };
	runtime: { sendMessage(message: unknown): Promise<unknown> };
};
const g = globalThis as { browser?: Api; chrome?: Api };
const api = (g.browser ?? g.chrome) as Api;

// Names the card this box belongs to. The card made it up; nothing else in the tab knows it.
const id = new URLSearchParams(location.search).get("id") ?? "";
const input = document.querySelector("input") as HTMLInputElement;
input.setAttribute("aria-label", api.i18n.getMessage("fieldUsername"));

function send(payload: Record<string, unknown>): Promise<Reply> {
	try {
		return api.runtime.sendMessage({ type: "CORNER_FIELD", payload: { id, ...payload } }).then(
			(reply) => reply as Reply,
			() => undefined,
		);
	} catch {
		// The extension was reloaded under this page.
		return Promise.resolve(undefined);
	}
}

/** Tell the card what the box holds; `flush` echoes the count of the save that asked. */
function report(flush?: number): void {
	void send({ op: "value", value: input.value, ...(flush === undefined ? {} : { flush }) });
}

let typed = false;
input.addEventListener("input", () => {
	typed = true;
	report();
});

// The card asks for the latest text as it saves. The ask is only a count and the answer goes to
// the card alone, so it does not matter who else can post here.
window.addEventListener("message", (e) => {
	const msg = e.data as { type?: string; n?: unknown } | undefined;
	if (e.source !== window.parent || msg?.type !== "CORNER_FIELD_FLUSH") return;
	if (typeof msg.n === "number") report(msg.n);
});

void send({ op: "open" }).then((reply) => {
	if (!reply?.ok) return;
	if (!typed) input.value = reply.data?.value ?? "";
	// The card shows this box on its first report.
	report();
});
