/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it } from "vitest";
import { chosenLanguage, localeFor, resolveLocale, setChosenLanguage } from "./i18n";

// #163: a UI language chosen in Settings, independent of the device's.

afterEach(() => localStorage.clear());

describe("the chosen language", () => {
	it("follows the system until one is chosen", () => {
		expect(chosenLanguage()).toBeNull();
		expect(localeFor("de-DE")).toBe("de");
	});

	it("wins over the system once chosen, and is kept", () => {
		setChosenLanguage("fr");
		expect(chosenLanguage()).toBe("fr");
		expect(localeFor("de-DE")).toBe("fr");
	});

	it("goes back to the system when cleared", () => {
		setChosenLanguage("fr");
		setChosenLanguage(null);
		expect(chosenLanguage()).toBeNull();
		expect(localeFor("de-DE")).toBe("de");
	});

	it("ignores a stored value that isn't a language Bramble has", () => {
		localStorage.setItem("bramble-language", "xx");
		expect(chosenLanguage()).toBeNull();
		expect(localeFor("es-419")).toBe(resolveLocale("es-419"));
	});
});
