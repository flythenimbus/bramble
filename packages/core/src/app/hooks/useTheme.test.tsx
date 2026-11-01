/** @vitest-environment happy-dom */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { type Platform, PlatformProvider } from "../../context/PlatformContext";
import { ThemeProvider, useTheme } from "./useTheme";

// The OS draws the status bar icons, so it has to be told the app's theme: an explicit
// light/dark choice in Settings can disagree with the OS scheme (github issue #173).

const setSystemBarsDark = vi.fn();
const platform = { shell: { setSystemBarsDark } } as unknown as Platform;

let setMode: ReturnType<typeof useTheme>["setThemeMode"] = () => {};
function Probe() {
	setMode = useTheme().setThemeMode;
	return null;
}

const mount = () =>
	render(
		<PlatformProvider platform={platform}>
			<ThemeProvider>
				<Probe />
			</ThemeProvider>
		</PlatformProvider>,
	);

afterEach(() => {
	cleanup();
	localStorage.clear();
	setSystemBarsDark.mockClear();
});

it("tells the shell the theme the user picked, not the OS's", () => {
	localStorage.setItem("vault-theme", "dark");
	mount();
	expect(setSystemBarsDark).toHaveBeenLastCalledWith(true);

	act(() => setMode("light"));
	expect(setSystemBarsDark).toHaveBeenLastCalledWith(false);
});

it("follows the OS scheme under the system setting", () => {
	const osDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
	mount();
	expect(setSystemBarsDark).toHaveBeenLastCalledWith(osDark);
});
