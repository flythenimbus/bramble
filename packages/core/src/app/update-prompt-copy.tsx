// Copy for the desktop's launch-time update dialog.
//
// It lives in core rather than next to the dialog because that is where the extractor looks: the
// catalogs cover packages/core/src only, so the same sentence written in the desktop package would
// ship untranslated to every locale. The dialog itself is native and stays over there.
//
// `.tsx` for the same reason everything else here is: the Lingui macro plugin only transforms that
// extension. There is no JSX in it.

import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";

export interface UpdatePromptCopy {
	title: string;
	body: string;
	ok: string;
	cancel: string;
}

/** Shown when a check the user asked for finds nothing. Silence would read as a broken check. */
export function upToDateCopy(version: string): { title: string; body: string } {
	if (!i18n.locale)
		return {
			title: "Bramble is up to date",
			body: `You are running the latest version (${version}).`,
		};
	return {
		title: i18n._(msg`Bramble is up to date`),
		body: i18n._(msg`You are running the latest version (${version}).`),
	};
}

/** Resolved at call time, not module load, so it follows the locale the user actually picked. */
export function updatePromptCopy(version: string): UpdatePromptCopy {
	// Lingui throws rather than falling back when no catalog is active yet, and this is called
	// from a launch timer that could in principle beat the locale load. The English below is a
	// duplicate on purpose: an English dialog is an acceptable outcome, and a swallowed exception
	// that shows no dialog at all is not, since nothing else tells anyone a fix exists.
	if (!i18n.locale) {
		return {
			title: "Update Bramble",
			body: `Bramble ${version} is available. Updating downloads it and restarts the app. Your vault is not touched.`,
			ok: "Update now",
			cancel: "Later",
		};
	}
	return {
		title: i18n._(msg`Update Bramble`),
		// Says what accepting does, because it restarts the app, and says what it does not do,
		// because "update" over a password vault reads as risk to anyone who has not been told.
		body: i18n._(
			msg`Bramble ${version} is available. Updating downloads it and restarts the app. Your vault is not touched.`,
		),
		ok: i18n._(msg`Update now`),
		cancel: i18n._(msg`Later`),
	};
}
