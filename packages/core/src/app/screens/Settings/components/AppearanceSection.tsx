import { useLingui } from "@lingui/react/macro";
import { Languages, Palette } from "lucide-react";
import { useState } from "react";
import {
	activateLocale,
	chosenLanguage,
	type Locale,
	locales,
	resolveLocale,
	setChosenLanguage,
	systemLocaleTag,
} from "../../../../i18n";
import { SelectField } from "../../../components/ui/select-field";
import { type ThemeMode, useTheme } from "../../../hooks/useTheme";
import { Row, Section } from "./primitives";

/** Appearance (theme and language). Shown under the General tab. */
export function AppearanceSection() {
	const { themeMode, setThemeMode } = useTheme();
	const { t } = useLingui();
	const [language, setLanguage] = useState<Locale | "system">(() => chosenLanguage() ?? "system");

	// Applied at once: the catalog swaps and every rendered string follows (#163).
	const chooseLanguage = (value: Locale | "system") => {
		setLanguage(value);
		setChosenLanguage(value === "system" ? null : value);
		void activateLocale(value === "system" ? resolveLocale(systemLocaleTag()) : value);
	};

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
			<Row
				icon={<Languages className="w-4 h-4 text-primary" />}
				title={t`Language`}
				subtitle={t`Use a different language from your system`}
			>
				<div className="w-44">
					<SelectField
						label={t`Language`}
						value={language}
						onChange={(e) => chooseLanguage(e.target.value as Locale | "system")}
					>
						<option value="system">{t`System`}</option>
						{/* Each in its own language, so someone can find theirs whatever is showing. */}
						{(Object.entries(locales) as [Locale, string][]).map(([code, name]) => (
							<option key={code} value={code} lang={code}>
								{name}
							</option>
						))}
					</SelectField>
				</div>
			</Row>
		</Section>
	);
}
