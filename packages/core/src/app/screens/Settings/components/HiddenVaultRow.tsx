import { Trans } from "@lingui/react/macro";
import { useVaultActions } from "../../../../hooks/useVault";
import { useVaultRegistry } from "../../../../hooks/useVaultRegistry";
import { displayLabel, type VaultRecord } from "../../../../vault/vault-registry";
import { Button } from "../../../components/ui/button";
import { InlineConfirm } from "../../../components/ui/inline-confirm";

/** The question a closed dialog left open: a vault combined into the desktop's, hidden until the
 * user deletes or keeps it. */
export function HiddenVaultRow({ vault, index }: { vault: VaultRecord; index: number }) {
	const { deleteHiddenVault } = useVaultActions();
	const { show } = useVaultRegistry();
	const name = displayLabel(vault.label, index);
	return (
		<div className="space-y-2">
			<p className="text-xs text-muted-foreground">
				<Trans>
					{name} is hidden on this browser. Its entries were copied into the desktop's vault.
				</Trans>
			</p>
			<div className="flex justify-end gap-2">
				<Button variant="secondary" size="sm" onClick={() => void show(vault.id)}>
					<Trans>Keep it</Trans>
				</Button>
				<InlineConfirm
					variant="destructiveOutline"
					confirmLabel={<Trans>Delete it</Trans>}
					onConfirm={async () => {
						await deleteHiddenVault(vault.id);
					}}
					trigger={(arm) => (
						<Button variant="secondary" size="sm" onClick={arm}>
							<Trans>Delete</Trans>
						</Button>
					)}
				/>
			</div>
		</div>
	);
}
