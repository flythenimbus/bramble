import { useEffect, useState } from "react";
import type { EnrollApproval, ShellAdapter } from "../adapters/shell";

/** The slice of the shell this needs, so tests can supply a two-method fake. */
export type ApprovalShell = Pick<ShellAdapter, "onSyncEvent" | "getPendingEnrollApproval">;

/**
 * The inviter's pending "is this your device?" prompt, kept in step with the sync host.
 *
 * The host raises the prompt through a fire-and-forget event, which is one delivery attempt to
 * whoever is attached at that instant. That is not enough on its own: the panel re-renders and
 * re-subscribes during pairing, an extension popup closes on focus loss and comes back, and on
 * mobile `emit` is a synchronous walk over the current subscriber set. A prompt raised in any of
 * those gaps reaches nobody and is lost for good, leaving the verification code showing on the
 * joiner only, until a retry happens to land differently.
 *
 * So the host is treated as the authority and this converges on it three ways: the event, a
 * re-read whenever we attach, and a poll while an invite is open. Only the first is fast; the
 * other two exist so a missed delivery cannot strand a pairing.
 */
export function usePendingEnrollApproval(
	shell: ApprovalShell,
	/** Whether an invite is currently open, which bounds the poll. */
	inviteOpen: boolean,
): [EnrollApproval | null, (next: EnrollApproval | null) => void] {
	const [approval, setApproval] = useState<EnrollApproval | null>(null);

	useEffect(() => {
		const off = shell.onSyncEvent((e) => {
			if (e.kind === "enroll-approval" && e.sas) setApproval({ sas: e.sas, label: e.label ?? "" });
			// Anything that ends the exchange also ends the prompt: there is nothing left to approve.
			if (e.kind === "enrolled" || e.kind === "enroll-expired" || e.kind === "enroll-failed") {
				setApproval(null);
			}
		});
		void shell.getPendingEnrollApproval?.().then((p) => {
			if (p) setApproval(p);
		});
		return off;
	}, [shell]);

	useEffect(() => {
		if (!inviteOpen || approval !== null) return;
		const id = setInterval(() => {
			void shell.getPendingEnrollApproval?.().then((p) => {
				if (p) setApproval(p);
			});
		}, POLL_MS);
		return () => clearInterval(id);
	}, [shell, inviteOpen, approval]);

	return [approval, setApproval];
}

// Fast enough that a dropped event is not perceptible, and it only runs while an invite is open,
// which the host caps at INVITE_TTL_MS.
const POLL_MS = 1500;
