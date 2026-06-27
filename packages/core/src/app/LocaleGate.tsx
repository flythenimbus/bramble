import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { type ReactNode, useEffect, useState } from "react";
import { activateLocale, defaultLocale, resolveLocale } from "../i18n";

/**
 * Activates the right catalog before first paint, then provides it to the tree.
 * Every root that renders Lingui macros (App AND OptionsApp) must sit inside this
 * — `<Trans>`/`useLingui` throw without an I18nProvider, which blanks the screen.
 *
 * `preferredLocale` is the host-detected BCP-47 tag (mobile passes Capacitor's
 * Device language); falls back to navigator.language, then the source locale.
 */
export function LocaleGate({
	preferredLocale,
	children,
}: {
	preferredLocale?: string;
	children: ReactNode;
}) {
	// Start ready if a locale is already active (e.g. App activated it before the
	// host swapped in OptionsApp) to avoid a null flash; otherwise gate on the effect.
	const [ready, setReady] = useState(() => Boolean(i18n.locale));
	useEffect(() => {
		const tag =
			preferredLocale ?? (typeof navigator !== "undefined" ? navigator.language : undefined);
		activateLocale(resolveLocale(tag))
			.catch(() => activateLocale(defaultLocale))
			.finally(() => setReady(true));
	}, [preferredLocale]);

	if (!ready) return null;
	return <I18nProvider i18n={i18n}>{children}</I18nProvider>;
}
