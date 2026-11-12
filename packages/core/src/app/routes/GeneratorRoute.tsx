import { useLingui } from "@lingui/react/macro";
import { AtSign, Dices } from "lucide-react";
import { AliasGenerator } from "../components/AliasGenerator";
import { PasswordGenerator } from "../components/PasswordGenerator";
import { Section } from "../screens/Settings/components/primitives";

/** The generators on their own, for a password (#162) or an email alias (#120) needed before there
 * is an entry to put it in. Without `onUse` the password generator has no action row: the value is
 * copied from the generator itself. */
export function GeneratorRoute() {
	const { t } = useLingui();
	return (
		<div className="flex-1 overflow-y-auto">
			<main className="max-w-5xl mx-auto px-4 py-5 space-y-6">
				<Section icon={<Dices className="w-4 h-4 text-primary" />} title={t`Generate password`}>
					<PasswordGenerator />
				</Section>
				<Section icon={<AtSign className="w-4 h-4 text-primary" />} title={t`Email alias`}>
					<AliasGenerator />
				</Section>
			</main>
		</div>
	);
}
