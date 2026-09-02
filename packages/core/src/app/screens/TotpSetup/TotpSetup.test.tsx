/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { cleanup, fireEvent, type RenderResult, render, screen } from "@testing-library/react";
import { KeyRound } from "lucide-react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TotpSetup, TotpSetupFailure, type TotpTarget } from "./TotpSetup";

const draw = (ui: React.ReactNode): RenderResult =>
	render(<I18nProvider i18n={i18n}>{ui}</I18nProvider>);

afterEach(cleanup);

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});

const target = (id: string, overrides: Partial<TotpTarget> = {}): TotpTarget => ({
	id,
	name: id,
	secondary: "user@example.com",
	icon: KeyRound,
	hasTotp: false,
	...overrides,
});

const setup = (props: Partial<Parameters<typeof TotpSetup>[0]> = {}) => {
	const onCreateNew = vi.fn();
	const onPick = vi.fn();
	draw(
		<TotpSetup
			issuer="GitHub"
			account="octocat"
			targets={[target("github")]}
			query=""
			onQueryChange={vi.fn()}
			onCreateNew={onCreateNew}
			onPick={onPick}
			{...props}
		/>,
	);
	return { onCreateNew, onPick };
};

describe("TotpSetup", () => {
	it("names the account the key is for", () => {
		setup();
		expect(screen.getByText("GitHub")).toBeTruthy();
		expect(screen.getByText("octocat")).toBeTruthy();
	});

	// A bare setup key carries no issuer or account, and an empty header line reads as a
	// rendering bug rather than as "this key just didn't say".
	it("falls back to naming the kind of thing that arrived when the key is bare", () => {
		setup({ issuer: "", account: "", targets: [] });
		expect(screen.getByText("Authenticator key")).toBeTruthy();
	});

	it("offers a new login", () => {
		const { onCreateNew } = setup();
		fireEvent.click(screen.getByText("Save to a new login"));
		expect(onCreateNew).toHaveBeenCalled();
	});

	it("picks an existing login by id", () => {
		const { onPick } = setup({ targets: [target("a"), target("b")] });
		fireEvent.click(screen.getByText("b"));
		expect(onPick).toHaveBeenCalledWith("b");
	});

	// The warning belongs at the point of decision: the edit form it routes to shows a
	// filled-in field with no hint that it just replaced a working key.
	it("warns on a login that already holds a key, and only that one", () => {
		setup({ targets: [target("a"), target("b", { hasTotp: true })] });
		expect(screen.getAllByText("Replaces code")).toHaveLength(1);
	});

	it("says so when the search matches nothing", () => {
		setup({ targets: [], query: "zzz" });
		expect(screen.getByText("No logins match.")).toBeTruthy();
	});
});

describe("TotpSetupFailure", () => {
	// The scanner's copy blames the QR ("make it visible and retry"), which is nonsense for
	// a link an app sent us. Each verdict has to name the way out that actually applies.
	it("names the vendor whose app the link activates", () => {
		draw(
			<TotpSetupFailure
				failure="vendor-app"
				vendor="Microsoft Authenticator"
				onDismiss={vi.fn()}
			/>,
		);
		expect(screen.getByText(/Microsoft Authenticator/)).toBeTruthy();
	});

	it("explains an export blob rather than calling it invalid", () => {
		draw(<TotpSetupFailure failure="migration" onDismiss={vi.fn()} />);
		expect(screen.getByText(/several accounts/)).toBeTruthy();
	});

	it("calls out HOTP, the one shape that parses but can't be generated", () => {
		draw(<TotpSetupFailure failure="not-totp" onDismiss={vi.fn()} />);
		expect(screen.getByText(/HOTP/)).toBeTruthy();
	});

	it("dismisses back to the vault", () => {
		const onDismiss = vi.fn();
		draw(<TotpSetupFailure failure="not-found" onDismiss={onDismiss} />);
		fireEvent.click(screen.getByText("Back to vault"));
		expect(onDismiss).toHaveBeenCalled();
	});
});
