/** @vitest-environment happy-dom */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EnrollApproval, SyncEvent } from "../adapters/shell";
import { type ApprovalShell, usePendingEnrollApproval } from "./usePendingEnrollApproval";

// Field report, Android to macOS: the joiner showed the code and the inviter showed nothing, then
// it worked on the third try. The joiner derives its code after SENDING its introduction; the
// inviter only after RECEIVING it, so a dropped prompt shows the code on one side only.

const PROMPT: EnrollApproval = { sas: "1234 5678 9012", label: "Pixel 8" };

/** A host whose event delivery can be dropped on demand, and which holds a pending approval the
 * way the real hosts do (offscreen document / mobile sync-manager). */
function fakeShell(pending: EnrollApproval | null = null) {
	const subs = new Set<(e: SyncEvent) => void>();
	let held = pending;
	const shell: ApprovalShell = {
		onSyncEvent: (cb) => {
			subs.add(cb);
			return () => subs.delete(cb);
		},
		getPendingEnrollApproval: async () => held,
	};
	return {
		shell,
		subscriberCount: () => subs.size,
		/** Raise a prompt the way the host does: hold it, then notify whoever is attached. */
		raise: (approval: EnrollApproval = PROMPT) => {
			held = approval;
			for (const cb of subs) cb({ kind: "enroll-approval", ...approval });
		},
		/** Raise it with NOBODY attached, i.e. into the teardown gap. The host still holds it. */
		raiseUndelivered: (approval: EnrollApproval = PROMPT) => {
			held = approval;
		},
		settle: (kind: SyncEvent["kind"]) => {
			held = null;
			for (const cb of subs) cb({ kind });
		},
	};
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** Let the hook's awaited getPendingEnrollApproval resolve. */
const flush = async () => {
	await act(async () => {
		await Promise.resolve();
	});
};

describe("usePendingEnrollApproval", () => {
	it("shows a prompt delivered by the event", async () => {
		const host = fakeShell();
		const { result } = renderHook(() => usePendingEnrollApproval(host.shell, true));
		await flush();
		expect(result.current[0]).toBeNull();

		act(() => host.raise());
		expect(result.current[0]).toEqual(PROMPT);
	});

	it("recovers a prompt raised before it was listening", async () => {
		// The popup was closed (or between renders) when the host raised it.
		const host = fakeShell(PROMPT);
		const { result } = renderHook(() => usePendingEnrollApproval(host.shell, true));
		await flush();
		expect(result.current[0]).toEqual(PROMPT);
	});

	it("recovers a prompt whose event reached nobody, without a re-subscribe", async () => {
		// The reported bug. The host holds it, the event was delivered into a teardown gap, and
		// nothing re-attaches afterwards, so only the poll can converge.
		const host = fakeShell();
		const { result } = renderHook(() => usePendingEnrollApproval(host.shell, true));
		await flush();

		host.raiseUndelivered();
		expect(result.current[0]).toBeNull(); // nothing told us

		await act(async () => {
			await vi.advanceTimersByTimeAsync(2_000);
		});
		expect(result.current[0]).toEqual(PROMPT);
	});

	it("does not poll when no invite is open", async () => {
		const host = fakeShell();
		const spy = vi.spyOn(host.shell, "getPendingEnrollApproval");
		const { result } = renderHook(() => usePendingEnrollApproval(host.shell, false));
		await flush();
		spy.mockClear();

		host.raiseUndelivered();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10_000);
		});

		// Idle panels must not round-trip to the host forever; the invite window bounds this.
		expect(spy).not.toHaveBeenCalled();
		expect(result.current[0]).toBeNull();
	});

	it("stops polling once a prompt is showing", async () => {
		const host = fakeShell();
		const { result } = renderHook(() => usePendingEnrollApproval(host.shell, true));
		await flush();
		act(() => host.raise());

		const spy = vi.spyOn(host.shell, "getPendingEnrollApproval");
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10_000);
		});
		expect(spy).not.toHaveBeenCalled();
		expect(result.current[0]).toEqual(PROMPT);
	});

	it("clears the prompt when the exchange ends", async () => {
		for (const kind of ["enrolled", "enroll-expired", "enroll-failed"] as const) {
			const host = fakeShell();
			const { result, unmount } = renderHook(() => usePendingEnrollApproval(host.shell, true));
			await flush();
			act(() => host.raise());
			expect(result.current[0]).toEqual(PROMPT);

			act(() => host.settle(kind));
			expect(result.current[0]).toBeNull(); // nothing left to approve
			unmount();
		}
	});

	it("detaches on unmount, leaving no subscriber behind", async () => {
		const host = fakeShell();
		const { unmount } = renderHook(() => usePendingEnrollApproval(host.shell, true));
		await flush();
		expect(host.subscriberCount()).toBe(1);
		unmount();
		expect(host.subscriberCount()).toBe(0);
	});
});
