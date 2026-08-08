/** @vitest-environment happy-dom */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Platform, PlatformProvider } from "../context/PlatformContext";
import { useVault, useVaultActions, useVaultState, VaultProvider } from "./useVault";

afterEach(cleanup);

// VaultProvider translates the errors it rejects with; an empty catalog keeps source strings.
i18n.load("en", {});
i18n.activate("en");

// A platform that flips a piece of reactive state through a real action (lock, which resets
// entries + isLocked) without needing crypto/decrypt, so we can observe which consumers
// re-render.
function makePlatform() {
	const storage = {
		hasVaultHandle: vi.fn(async () => false),
	};
	const crypto = {
		isLocked: vi.fn(async () => true),
		lock: vi.fn(async () => {}),
		onExternalLock: vi.fn(() => () => {}),
		onExternalChange: vi.fn(() => () => {}),
	};
	const platform = {
		storage,
		crypto,
		autofill: { clearIndex: vi.fn(async () => {}) },
		shell: {},
		clipboard: {},
	} as unknown as Platform;
	return { platform, storage, crypto };
}

/** Mount a state-only and an action-only consumer under one VaultProvider, tracking renders. */
function renderSplit() {
	const stateRenders = { n: 0 };
	const actionRenders = { n: 0 };
	let capturedActions: ReturnType<typeof useVaultActions> | null = null;
	let pick = async () => {};

	function StateConsumer() {
		stateRenders.n++;
		const s = useVaultState();
		return <div data-testid="hasVault">{String(s.hasVault)}</div>;
	}
	function ActionConsumer() {
		actionRenders.n++;
		const a = useVaultActions();
		capturedActions = a;
		pick = () => a.lock();
		return null;
	}

	const { platform } = makePlatform();
	render(
		<I18nProvider i18n={i18n}>
			<PlatformProvider platform={platform}>
				<VaultProvider>
					<StateConsumer />
					<ActionConsumer />
				</VaultProvider>
			</PlatformProvider>
		</I18nProvider>,
	);

	return {
		stateRenders,
		actionRenders,
		getActions: () => capturedActions,
		pick: () => pick(),
	};
}

describe("useVault state/actions split", () => {
	it("does not re-render an action-only consumer when vault state changes", async () => {
		const h = renderSplit();
		// Flush the async mount effect (sets ready, probes the vault handle).
		await act(async () => {});

		const stateAfterMount = h.stateRenders.n;
		const actionsAfterMount = h.actionRenders.n;

		// lock flips reactive state (entries + isLocked) via a real action.
		await act(async () => {
			await h.pick();
		});

		// The state consumer re-rendered; the action-only consumer did not.
		expect(h.stateRenders.n).toBeGreaterThan(stateAfterMount);
		expect(h.actionRenders.n).toBe(actionsAfterMount);
	});

	it("keeps the actions object referentially stable across a state change", async () => {
		const h = renderSplit();
		await act(async () => {});
		const before = h.getActions();

		await act(async () => {
			await h.pick();
		});

		expect(h.getActions()).toBe(before);
	});

	it("throws when the hooks are used outside a VaultProvider", () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			function State() {
				useVaultState();
				return null;
			}
			function Actions() {
				useVaultActions();
				return null;
			}
			function Full() {
				useVault();
				return null;
			}
			expect(() => render(<State />)).toThrow(/useVaultState called outside VaultProvider/);
			expect(() => render(<Actions />)).toThrow(/useVaultActions called outside VaultProvider/);
			// useVault composes useVaultState first, so it surfaces that guard.
			expect(() => render(<Full />)).toThrow(/outside VaultProvider/);
		} finally {
			spy.mockRestore();
		}
	});
});
