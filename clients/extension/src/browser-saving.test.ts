import { beforeEach, describe, expect, it, vi } from "vitest";

// #135. Holding the optional `privacy` permission is the user's choice, so these pin down what
// each context does with it: take the browser's settings over where it can, hand them back on
// the way out, and never claim a setting a policy or another extension holds.

interface Setting {
	levelOfControl: string;
	value: boolean;
}

const h = vi.hoisted(() => ({
	held: false,
	grant: true,
	/** Whether this context has the `privacy` binding at all. */
	binding: true,
	/** Chromium has the card setting, Firefox does not. */
	cards: true,
	password: { levelOfControl: "controllable_by_this_extension", value: true } as Setting,
	card: { levelOfControl: "controllable_by_this_extension", value: true } as Setting,
	calls: [] as string[],
}));

function setting(name: "password" | "card") {
	return {
		get: async () => ({ ...h[name] }),
		set: async ({ value }: { value: boolean }) => {
			h.calls.push(`${name}.set:${value}`);
			if (h[name].levelOfControl === "not_controllable") throw new Error("policy");
			h[name] = { levelOfControl: "controlled_by_this_extension", value };
		},
		clear: async () => {
			h.calls.push(`${name}.clear`);
			h[name] = { levelOfControl: "controllable_by_this_extension", value: true };
		},
	};
}

vi.mock("./platform-api", () => ({
	api: {
		permissions: {
			contains: async () => h.held,
			request: async () => {
				h.calls.push("request");
				h.held = h.grant;
				return h.grant;
			},
			remove: async () => {
				h.calls.push("remove");
				h.held = false;
				return true;
			},
		},
		get privacy() {
			if (!h.binding || !h.held) return undefined;
			return {
				services: {
					passwordSavingEnabled: setting("password"),
					...(h.cards ? { autofillCreditCardEnabled: setting("card") } : {}),
				},
			};
		},
	},
}));

const { ownerOf, reconcileDefaultPasswordManager, setDefaultPasswordManager } = await import(
	"./browser-saving"
);

beforeEach(() => {
	h.held = false;
	h.grant = true;
	h.binding = true;
	h.cards = true;
	h.password = { levelOfControl: "controllable_by_this_extension", value: true };
	h.card = { levelOfControl: "controllable_by_this_extension", value: true };
	h.calls = [];
});

describe("ownerOf", () => {
	it.each([
		["controlled_by_this_extension", false, "bramble"],
		["controlled_by_this_extension", true, "browser"],
		["controllable_by_this_extension", true, "browser"],
		["not_controllable", true, "locked"],
		["controlled_by_other_extensions", false, "locked"],
	])("%s with value %s is %s", (levelOfControl, value, owner) => {
		expect(ownerOf({ levelOfControl, value })).toBe(owner);
	});
});

describe("setDefaultPasswordManager", () => {
	it("asks first, then turns off passwords and cards", async () => {
		expect(await setDefaultPasswordManager(true)).toBe("bramble");
		expect(h.calls).toEqual(["request", "password.set:false", "card.set:false"]);
	});

	it("changes nothing when the permission is refused", async () => {
		h.grant = false;
		expect(await setDefaultPasswordManager(true)).toBe("browser");
		expect(h.calls).toEqual(["request"]);
	});

	it("turns off passwords alone where there is no card setting", async () => {
		h.cards = false;
		expect(await setDefaultPasswordManager(true)).toBe("bramble");
		expect(h.calls).toEqual(["request", "password.set:false"]);
	});

	it("hands both settings back, then gives up the permission", async () => {
		await setDefaultPasswordManager(true);
		h.calls = [];
		expect(await setDefaultPasswordManager(false)).toBe("browser");
		expect(h.calls).toEqual(["password.clear", "card.clear", "remove"]);
		expect(h.held).toBe(false);
	});

	it("reports a policy-held setting as locked", async () => {
		h.password = { levelOfControl: "not_controllable", value: true };
		expect(await setDefaultPasswordManager(true)).toBe("locked");
	});
});

describe("reconcileDefaultPasswordManager", () => {
	it("leaves the browser alone without the permission", async () => {
		expect(await reconcileDefaultPasswordManager()).toBe("browser");
		expect(h.calls).toEqual([]);
	});

	// The popup that asked is gone; the next context to open applies the choice.
	it("applies a held choice that has not landed yet", async () => {
		h.held = true;
		expect(await reconcileDefaultPasswordManager()).toBe("bramble");
		expect(h.calls).toEqual(["password.set:false", "card.set:false"]);
	});

	it("does not rewrite settings it already holds", async () => {
		h.held = true;
		h.password = { levelOfControl: "controlled_by_this_extension", value: false };
		expect(await reconcileDefaultPasswordManager()).toBe("bramble");
		expect(h.calls).toEqual([]);
	});

	// Chromium: a context created before the grant never gains the binding.
	it("reports the choice from a context that cannot see the setting", async () => {
		h.held = true;
		h.binding = false;
		expect(await reconcileDefaultPasswordManager()).toBe("bramble");
		expect(h.calls).toEqual([]);
	});
});
