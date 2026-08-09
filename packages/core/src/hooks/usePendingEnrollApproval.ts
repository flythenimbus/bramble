import { useEffect, useState } from "react";
import type { EnrollApproval, ShellAdapter } from "../adapters/shell";

/** The slice of the shell this needs, so tests can supply a two-method fake. */
export type ApprovalShell = Pick<ShellAdapter, "onSyncEvent" | "getPendingEnrollApproval">;

/**
 * The inviter's pending "is this your device?" prompt, kept in step with the sync host.
 *
 * The host's event is one fire-and-forget delivery to whoever is attached at that instant, and a
 * prompt raised during a re-subscribe reaches nobody (which showed the code on the joiner only).
 * So the host is the authority, and this converges on it three ways: the event, a re-read on
 * attach, and a poll while an invite is open.
 */
export function usePendingEnrollApproval(
	shell: ApprovalShell,
	/** Whether an invite is currently open, which bounds the poll. */
	inviteOpen: boolean,
): [EnrollApproval | null, (next: EnrollApproval | null) => void] {
	const [approval, setApproval] = useState<EnrollApproval | null>(null);

	useEffect(() => {
		const off = shell.onSyncEvent((e) => {
			// Rebuilt field by field, so anything new on the event has to be added here too. It was
			// dropping sasEmoji, which is the form the user compares: the inviter silently fell back
			// to digits while the joiner showed symbols, so the two screens did not look alike.
			if (e.kind === "enroll-approval" && e.sas) {
				setApproval({ sas: e.sas, sasEmoji: e.sasEmoji, label: e.label ?? "" });
			}
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
