/// <reference types="chrome" />

import { generatePassphrase, generatePassword } from "@core/util/password-gen";
import { effWordlist } from "@core/util/wordlist-eff";
import { getGeneratorSettings } from "./prefs";
import { type MessageEnvelope, on } from "./router";

// Generation for the in-page suggestion. It happens here, not in the content script, because
// this is the side that can read the user's saved generator settings; the content script keeps
// its own fixed generator only as the fallback for when this doesn't answer.

/**
 * A password shaped by the user's settings.
 *
 * Calls the mode's generator directly rather than the shared `generate()`, whose lazy `import()`
 * of the wordlist is not dependable from a restarted MV3 service worker (see qr.ts). The
 * wordlist is a static import here and splits itself on first use, so a worker that never
 * generates a passphrase does not pay for it.
 */
export async function generateSuggestion(): Promise<string> {
	const settings = await getGeneratorSettings();
	return settings.mode === "passphrase"
		? generatePassphrase(settings, effWordlist())
		: generatePassword(settings);
}

async function handleGenerate(): Promise<MessageEnvelope> {
	return { ok: true, data: { password: await generateSuggestion() } };
}

// Not extensionOnly: the page's own dropdown is the caller, and a generated password is not
// vault data. It reveals only what the user has chosen for passwords they have yet to make.
on("GENERATE_PASSWORD", handleGenerate);
