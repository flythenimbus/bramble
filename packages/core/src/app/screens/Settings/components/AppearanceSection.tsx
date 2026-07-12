import { useLingui } from "@lingui/react/macro";
import { Palette } from "lucide-react";
import { SelectField } from "../../../components/ui/select-field";
import { type ThemeMode, useTheme } from "../../../hooks/useTheme";
import { Row, Section } from "./primitives";

/** Appearance (theme). Shown under the General tab. */
export function AppearanceSection() {
	const { themeMode, setThemeMode } = useTheme();
	const { t } = useLingui();
	return (
		<Section icon={<Palette className="w-4 h-4 text-primary" />} title={t`Appearance`}>
			<Row
				icon={<Palette className="w-4 h-4 text-primary" />}
				title={t`Theme`}
				subtitle={t`Use light, dark, or match your system`}
			>
				<div className="w-44">
					<SelectField
						label={t`Mode`}
						value={themeMode}
						onChange={(e) => setThemeMode(e.target.value as ThemeMode)}
					>
						<option value="light">{t`Light`}</option>
						<option value="dark">{t`Dark`}</option>
						<option value="system">{t`System`}</option>
					</SelectField>
				</div>
			</Row>
		</Section>
	);
}
