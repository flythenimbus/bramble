// Native calls still waiting for an answer, by plugin and method only (never arguments), so a
// save that stalls can say what it is waiting on. On iOS one stuck call holds up every plugin:
// Capacitor runs them all on a single queue. Wraps the bridge's own entry and exit points.

type Bridge = {
	toNative?: (...args: unknown[]) => unknown;
	fromNative?: (result: { callbackId?: unknown }) => unknown;
};

const inFlight = new Map<string, { call: string; since: number }>();

// Listener plumbing answers once per event or never, and console forwarding is noise.
const untracked = (plugin: unknown, method: unknown) =>
	plugin === "Console" || method === "addListener" || method === "removeListener";

export function trackNativeCalls(
	bridge: Bridge | undefined = (globalThis as { Capacitor?: Bridge }).Capacitor,
): void {
	const toNative = bridge?.toNative;
	const fromNative = bridge?.fromNative;
	if (!bridge || typeof toNative !== "function" || typeof fromNative !== "function") return;
	bridge.toNative = (...args: unknown[]) => {
		const id = toNative.apply(bridge, args);
		const [plugin, method] = args;
		if (!untracked(plugin, method)) {
			inFlight.set(String(id), { call: `${plugin}.${method}`, since: Date.now() });
		}
		return id;
	};
	bridge.fromNative = (result) => {
		inFlight.delete(String(result?.callbackId));
		return fromNative.call(bridge, result);
	};
}

/** Unanswered calls, oldest first, as "Plugin.method 42s". */
export function pendingNativeCalls(now: number = Date.now()): string[] {
	return [...inFlight.values()]
		.sort((a, b) => a.since - b.since)
		.map(({ call, since }) => `${call} ${Math.round((now - since) / 1000)}s`);
}
