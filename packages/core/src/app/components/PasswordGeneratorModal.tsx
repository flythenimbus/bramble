import { Trans } from "@lingui/react/macro";
import type { ReactNode } from "react";
import { PasswordGenerator } from "./PasswordGenerator";
import { Modal } from "./ui/modal";

interface PasswordGeneratorModalProps {
	open: boolean;
	onClose: () => void;
	/** Adopt the generated value. The modal closes itself afterwards. */
	onUse: (value: string) => void;
	useLabel?: ReactNode;
}

/**
 * The generator in a dialog, for a form that has a field to fill.
 *
 * A dialog rather than a menu hanging off the button: the entry form scrolls under a pinned
 * action bar, so an anchored panel would be clipped by it or scroll away from the field, and
 * replacing a password the user may already have typed deserves an explicit "Use" rather than
 * happening on the way past.
 */
export function PasswordGeneratorModal({
	open,
	onClose,
	onUse,
	useLabel,
}: PasswordGeneratorModalProps) {
	return (
		<Modal open={open} onClose={onClose}>
			<div className="p-5 space-y-4">
				<h3 className="text-base">
					<Trans>Generate password</Trans>
				</h3>
				<PasswordGenerator
					onUse={(value) => {
						onUse(value);
						onClose();
					}}
					onCancel={onClose}
					useLabel={useLabel}
				/>
			</div>
		</Modal>
	);
}
