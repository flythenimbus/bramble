import { useLingui } from "@lingui/react/macro";
import { Dices } from "lucide-react";
import { PasswordGenerator } from "../components/PasswordGenerator";
import { Section } from "../screens/Settings/components/primitives";

/** The generator on its own, for a password needed before there is an entry to put it in (#162).
 * Without `onUse` it has no action row: the value is copied from the generator itself. */
export function GeneratorRoute() {
	const { t } = useLingui();
	return (
		<div className="flex-1 overflow-y-auto">
			<main className="max-w-5xl mx-auto px-4 py-5">
				<Section icon={<Dices className="w-4 h-4 text-primary" />} title={t`Generate password`}>
					<PasswordGenerator />
				</Section>
			</main>
		</div>
	);
}
