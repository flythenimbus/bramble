// Formatting for the sync log in the Device sync panel (issue #230).

const pad = (n: number): string => String(n).padStart(2, "0");

function parts(ms: number): { date: string; time: string } {
	const d = new Date(ms);
	return {
		date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
		time: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
	};
}

/** Local date and time, as a copied line carries it. */
export function fullStamp(at: number): string {
	const { date, time } = parts(at);
	return `${date} ${time}`;
}

/** Just the time for a line from today, so the panel stays narrow; the date too otherwise. */
export function shortStamp(at: number, now: number): string {
	const line = parts(at);
	return line.date === parts(now).date ? line.time : `${line.date} ${line.time}`;
}

/** Status lines name a device by the first 8 characters of its sync key. */
const KEY_CHARS = 8;

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * Put each device's name after its key wherever a line mentions it: "synced with tG/Lnb18 (Alice's
 * iPad)". Matches whole words only. Relay session ids (hex) aren't device keys and stay as they are.
 */
export function deviceNamer(
	devices: { publicKey: string; name: string }[],
): (line: string) => string {
	const names = new Map<string, string>();
	for (const { publicKey, name } of devices) {
		if (publicKey.length >= KEY_CHARS && name) names.set(publicKey.slice(0, KEY_CHARS), name);
	}
	if (names.size === 0) return (line) => line;
	const keys = [...names.keys()].map(escapeRegExp).join("|");
	const re = new RegExp(`(^|\\s)(${keys})(?=$|[\\s:,])`, "g");
	return (line) =>
		line.replace(re, (_m, lead: string, key: string) => `${lead}${key} (${names.get(key)})`);
}
