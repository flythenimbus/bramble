// What linking the desktop app does to this browser, from what each side holds. The vault only
// ever travels from the desktop to the browser. See docs/desktop-link-onboarding.md.

export type LinkFrom = "setup" | "settings" | "add";
export type LinkSide = "none" | "empty" | "full";

/**
 * - `switch`: this browser already shares the desktop's vault; just open it.
 * - `add`: the desktop's vault arrives alongside the others (the user pressed Add a vault).
 * - `take`: the browser takes the desktop's vault; an empty browser vault is then removed.
 * - `combine`: the browser's entries go into the desktop's vault, without asking.
 * - `ask`: both hold something; the user chooses combine or keep separate.
 */
export type LinkOutcome = "switch" | "add" | "take" | "combine" | "ask";

export function linkOutcome(input: {
	from: LinkFrom;
	browser: LinkSide;
	desktop: Exclude<LinkSide, "none">;
	sharesGroup: boolean;
}): LinkOutcome {
	if (input.sharesGroup) return "switch";
	if (input.from === "add") return "add";
	if (input.browser !== "full") return "take";
	return input.desktop === "empty" ? "combine" : "ask";
}
