import { debug, error, info, warn } from "@tauri-apps/plugin-log";

// Send the webview's console into the Rust logger, so it lands in the same file the backend
// already writes (~/Library/Logs/app.bramble.desktop/Bramble.log and the per-OS equivalents).
//
// The backend log exists because a refused pairing had nowhere to explain itself (see lib.rs).
// Half of pairing is up here though: enrollment, the SAS approval and the whole sync handshake
// are frontend code, and a release build has devtools compiled out, so on a SHIPPED app that half
// could not be observed at all. A user reporting "it just said rejected" left nothing to read.
//
// A tee rather than a redirect: the console keeps working for `pnpm dev:desktop`, and the copy
// goes to the file for everyone else.
//
// Main window only. The spotlight has its own capability, kept deliberately narrow because that
// window is always alive and always on top, and nothing worth diagnosing here happens in it. Adding
// this there means adding `log:default` to spotlight.json too.

/** Console methods worth persisting. `trace` is left alone: it is noise, and it is never load-bearing. */
const LEVELS = {
	debug: debug,
	log: info,
	info: info,
	warn: warn,
	error: error,
} as const;

/**
 * Arguments as one line the log file can hold.
 *
 * Errors get their message and stack, because `String(err)` on an Error loses the stack and the
 * stack is the whole reason anyone reads this. Anything non-primitive is JSON, and anything that
 * will not serialize (a cycle, a DOM node) degrades to its default string rather than throwing:
 * a logger that can throw turns a diagnosable failure into two.
 */
function format(args: unknown[]): string {
	return args
		.map((a) => {
			if (typeof a === "string") return a;
			if (a instanceof Error) return `${a.name}: ${a.message}\n${a.stack ?? ""}`;
			try {
				return JSON.stringify(a);
			} catch {
				return String(a);
			}
		})
		.join(" ");
}

let installed = false;

/** Idempotent: two windows share this module, and patching a patched console would double every line. */
export function forwardConsoleToLog(): void {
	if (installed) return;
	installed = true;
	for (const [name, send] of Object.entries(LEVELS) as [keyof typeof LEVELS, typeof info][]) {
		const original = console[name].bind(console);
		console[name] = (...args: unknown[]) => {
			original(...args);
			// Fire-and-forget, and swallowing is deliberate: a failed log must never surface as an
			// error in the thing being logged, and reporting it through console would recurse.
			void send(format(args)).catch(() => {});
		};
	}
}
