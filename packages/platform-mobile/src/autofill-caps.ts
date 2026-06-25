import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";

// Whether the device's active keyboard can show inline autofill suggestions (the Android
// equivalent of iOS QuickType). The native AutofillService records this on each fill request
// (it depends on the keyboard: Gboard / SwiftKey yes, the AOSP keyboard no). It is unknown
// until the user has autofilled once, so default to false: Settings hides the
// keyboard-suggestions control until the capability is confirmed, rather than show a control
// that can't work. See docs/mobile-port.md.
const FILE = "autofill_caps.json";
const DIR = Directory.Data;

export async function inlineSuggestionsSupported(): Promise<boolean> {
	try {
		const r = await Filesystem.readFile({ path: FILE, directory: DIR, encoding: Encoding.UTF8 });
		return JSON.parse(r.data as string)?.inlineSupported === true;
	} catch {
		return false;
	}
}
