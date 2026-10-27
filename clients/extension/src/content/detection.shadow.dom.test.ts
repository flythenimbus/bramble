/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
	candidateKind,
	cardFieldsPresent,
	closestAcrossShadow,
	composedTarget,
	deepActiveElement,
	deepQuery,
	deepQueryAll,
	detectCardFields,
	detectLoginFields,
	findPasswordField,
	otpInputs,
} from "./detection";

beforeEach(() => {
	document.body.innerHTML = "";
});

/** Make a web-component-like host with a shadow root containing `inner` HTML. */
function host(tag: string, mode: "open" | "closed", inner: string): HTMLElement {
	const el = document.createElement(tag);
	const root = el.attachShadow({ mode });
	root.innerHTML = inner;
	return el;
}

describe("deep traversal primitives", () => {
	it("deepQueryAll descends into open shadow roots", () => {
		const h = host("x-field", "open", `<input id="inner" type="text">`);
		document.body.append(h);
		const found = deepQueryAll<HTMLInputElement>("input");
		expect(found).toHaveLength(1);
		expect(found[0]?.id).toBe("inner");
	});

	it("deepQuery returns the first match across boundaries", () => {
		document.body.append(
			host("x-a", "open", `<input id="a">`),
			host("x-b", "open", `<input id="b">`),
		);
		expect(deepQuery<HTMLInputElement>("input")?.id).toBe("a");
	});

	it("preserves DFS pre-order: host A's input before host B's", () => {
		document.body.append(
			host("x-a", "open", `<input id="a" type="text">`),
			host("x-b", "open", `<input id="b" type="text">`),
		);
		expect(deepQueryAll<HTMLInputElement>("input").map((el) => el.id)).toEqual(["a", "b"]);
	});

	it("nested shadow roots are reached", () => {
		const outer = document.createElement("x-outer");
		const outerRoot = outer.attachShadow({ mode: "open" });
		const inner = host("x-inner", "open", `<input id="deep">`);
		outerRoot.append(inner);
		document.body.append(outer);
		expect(deepQuery<HTMLInputElement>("input")?.id).toBe("deep");
	});

	it("closed shadow roots are invisible", () => {
		document.body.append(host("x-closed", "closed", `<input type="password">`));
		expect(deepQuery("input")).toBeNull();
		expect(findPasswordField()).toBeNull();
	});

	it("light-DOM results are unchanged (still document order)", () => {
		document.body.innerHTML = `<input id="one"><div><input id="two"></div>`;
		expect(deepQueryAll<HTMLInputElement>("input").map((el) => el.id)).toEqual(["one", "two"]);
	});

	it("closestAcrossShadow hops from a shadow input to the light-DOM form", () => {
		const form = document.createElement("form");
		const h = host("x-field", "open", `<input id="inner">`);
		form.append(h);
		document.body.append(form);
		const input = deepQuery<HTMLInputElement>("input")!;
		expect(closestAcrossShadow(input, "form")).toBe(form);
	});

	it("deepActiveElement returns the focused input inside a shadow root", () => {
		const h = host("x-field", "open", `<input id="inner">`);
		document.body.append(h);
		const input = h.shadowRoot!.querySelector<HTMLInputElement>("input")!;
		input.focus();
		expect(deepActiveElement()?.id).toBe("inner");
	});

	it("composedTarget gives the inner input for a composed event at document level", () => {
		const h = host("x-field", "open", `<input id="inner">`);
		document.body.append(h);
		const input = h.shadowRoot!.querySelector<HTMLInputElement>("input")!;
		let seen: EventTarget | null = null;
		const listener = (e: Event) => {
			seen = composedTarget(e);
		};
		document.addEventListener("input", listener, true);
		input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
		document.removeEventListener("input", listener, true);
		expect(seen).toBe(input);
	});
});

describe("reddit-style login: each field in its own open shadow root", () => {
	function build(): { user: HTMLInputElement; pass: HTMLInputElement } {
		const form = document.createElement("form");
		const userHost = host(
			"faceplate-text-input",
			"open",
			`<input type="text" name="login-username" autocomplete="username webauthn">`,
		);
		const passHost = host(
			"faceplate-text-input",
			"open",
			`<input type="password" name="login-password" autocomplete="current-password">`,
		);
		form.append(userHost, passHost);
		document.body.append(form);
		return {
			user: userHost.shadowRoot!.querySelector("input")!,
			pass: passHost.shadowRoot!.querySelector("input")!,
		};
	}

	it("detectLoginFields pairs username + password across the two hosts", () => {
		const { user, pass } = build();
		const fields = detectLoginFields();
		expect(fields.username).toBe(user);
		expect(fields.password).toBe(pass);
	});

	it("classifies both fields as login", () => {
		const { user, pass } = build();
		expect(candidateKind(user)).toBe("login");
		expect(candidateKind(pass)).toBe("login");
	});

	it("no card / OTP false positives", () => {
		build();
		expect(cardFieldsPresent(detectCardFields())).toBe(false);
		expect(otpInputs()).toEqual([]);
	});

	it("falls back to the autocomplete rung when there's no password yet (username step)", () => {
		const form = document.createElement("form");
		form.append(
			host(
				"faceplate-text-input",
				"open",
				`<input type="text" name="u" autocomplete="username webauthn">`,
			),
		);
		document.body.append(form);
		const fields = detectLoginFields();
		expect(fields.username?.getAttribute("name")).toBe("u");
		expect(fields.password).toBeNull();
	});

	it("a closed password host makes the form undetectable (documents the limit)", () => {
		const form = document.createElement("form");
		form.append(
			host("faceplate-text-input", "open", `<input type="text" autocomplete="username">`),
			host("faceplate-text-input", "closed", `<input type="password">`),
		);
		document.body.append(form);
		// Username still detected via the autocomplete rung; password unreachable.
		expect(detectLoginFields().password).toBeNull();
	});
});

describe("deep traversal order", () => {
	// deepQueryAll takes a native querySelectorAll when the page has no open
	// shadow root and walks by hand when it does (issue #59). Both must produce
	// the one pre-order the "nearest preceding input" rungs depend on: the
	// element, then its shadow content, then its light children.
	function reference(selector: string, root: ParentNode): Element[] {
		const out: Element[] = [];
		const visit = (parent: ParentNode): void => {
			for (const el of Array.from(parent.children)) {
				if (el.matches(selector)) out.push(el);
				if (el.shadowRoot) visit(el.shadowRoot);
				visit(el);
			}
		};
		visit(root);
		return out;
	}

	const ids = (els: Element[]): string[] => els.map((el) => el.id);

	it("matches the reference walk through nested roots and slotted light children", () => {
		document.body.innerHTML = `<input id="a"><div><input id="b"></div>`;
		const outer = host("x-outer", "open", `<input id="c"><span><input id="d"></span><slot></slot>`);
		// A light child (projected through the slot) and a host nested in the shadow tree.
		outer.innerHTML = `<input id="e">`;
		outer.shadowRoot?.append(host("x-inner", "open", `<input id="f">`));
		document.body.append(outer);
		document.body.insertAdjacentHTML("beforeend", `<input id="g">`);

		expect(ids(deepQueryAll("input"))).toEqual(ids(reference("input", document)));
		expect(ids(deepQueryAll("input"))).toEqual(["a", "b", "c", "d", "f", "e", "g"]);
	});

	it("matches the reference walk on a page with no shadow root at all", () => {
		document.body.innerHTML = `<input id="a"><section><input id="b"><div><input id="c"></div></section><input id="d">`;
		expect(ids(deepQueryAll("input"))).toEqual(ids(reference("input", document)));
		expect(deepQuery("input")?.id).toBe("a");
	});
});

describe("shadow-DOM card + OTP", () => {
	it("detectCardFields finds cc-* inputs inside a shadow root", () => {
		document.body.append(
			host(
				"x-card",
				"open",
				`<input autocomplete="cc-number"><input autocomplete="cc-name"><input autocomplete="cc-exp">`,
			),
		);
		const c = detectCardFields();
		expect(c.number?.getAttribute("autocomplete")).toBe("cc-number");
		expect(c.name?.getAttribute("autocomplete")).toBe("cc-name");
		expect(c.expCombined?.getAttribute("autocomplete")).toBe("cc-exp");
	});

	it("otpInputs finds a one-time-code input inside a shadow root", () => {
		document.body.append(
			host("x-otp", "open", `<input autocomplete="one-time-code" inputmode="numeric">`),
		);
		const otps = otpInputs();
		expect(otps).toHaveLength(1);
		expect(otps[0]?.getAttribute("autocomplete")).toBe("one-time-code");
	});
});
