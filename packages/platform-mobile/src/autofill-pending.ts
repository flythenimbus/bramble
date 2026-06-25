import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import type { PendingLogin } from "@core/index";

// The main-app side of the Android autofill "save login" handoff. The native
// AutofillService writes a captured credential to this app-private file (Directory.Data,
// same store the vault lives in) and launches the app; here we read and delete it, then the
// app opens a prefilled add-login form once the vault is unlocked. iOS has no save flow, so
// the file simply never exists there. See docs/mobile-port.md.
const FILE = "autofill_pending_save.json";
const DIR = Directory.Data;

/** Read and remove the pending captured credential, if the autofill provider left one. */
export async function consumePendingAutofillSave(): Promise<PendingLogin | null> {
	try {
		await Filesystem.stat({ path: FILE, directory: DIR });
	} catch {
		return null; // no handoff waiting
	}
	try {
		const r = await Filesystem.readFile({ path: FILE, directory: DIR, encoding: Encoding.UTF8 });
		await Filesystem.deleteFile({ path: FILE, directory: DIR }).catch(() => {});
		const d = JSON.parse(r.data as string);
		if (typeof d?.password !== "string" || d.password.length === 0) return null;
		return {
			host: typeof d.host === "string" ? d.host : "",
			username: typeof d.username === "string" ? d.username : "",
			password: d.password,
		};
	} catch {
		// Corrupt or partial file: drop it so it can't wedge every launch.
		await Filesystem.deleteFile({ path: FILE, directory: DIR }).catch(() => {});
		return null;
	}
}
