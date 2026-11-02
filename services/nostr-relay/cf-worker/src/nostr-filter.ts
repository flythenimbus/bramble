// REQ and EVENT shape checks, in parity with node/relay.mjs. The fan-out runs inside the
// publisher's handler, so a filter or event it cannot read would abort delivery to everyone.

export type NostrFilter = {
	kinds?: number[];
	authors?: string[];
	[tag: `#${string}`]: string[] | undefined;
};

export type NostrEvent = {
	id?: string;
	kind: number;
	pubkey?: string;
	tags?: string[][];
	content?: string;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

const isStrings = (value: unknown): boolean =>
	Array.isArray(value) && value.every((v) => typeof v === "string");

export function validFilter(filter: unknown): filter is NostrFilter {
	if (!isObject(filter)) return false;
	return Object.entries(filter).every(([key, values]) => {
		if (key === "kinds") return Array.isArray(values) && values.every(Number.isInteger);
		if (key === "authors" || key.startsWith("#")) return isStrings(values);
		return true;
	});
}

export function validReq(subId: unknown, filters: unknown[]): subId is string {
	return (
		typeof subId === "string" &&
		subId.length > 0 &&
		subId.length <= 64 &&
		filters.length > 0 &&
		filters.every(validFilter)
	);
}

export function ephemeralEvent(event: unknown): event is NostrEvent {
	return (
		isObject(event) &&
		Number.isInteger(event.kind) &&
		(event.kind as number) >= 20000 &&
		(event.kind as number) < 30000
	);
}

export function validEventFields(event: NostrEvent): boolean {
	return (
		(event.id === undefined || typeof event.id === "string") &&
		(event.pubkey === undefined || typeof event.pubkey === "string") &&
		(event.content === undefined || typeof event.content === "string") &&
		(event.tags === undefined || (Array.isArray(event.tags) && event.tags.every(isStrings)))
	);
}

/** True if `event` matches a single REQ `filter` (kinds, authors, #<tag>). */
export function matches(filter: NostrFilter, event: NostrEvent): boolean {
	if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
	if (filter.authors && !(event.pubkey && filter.authors.includes(event.pubkey))) return false;
	for (const [key, vals] of Object.entries(filter)) {
		if (!key.startsWith("#") || !Array.isArray(vals)) continue;
		const tag = key.slice(1);
		const present = event.tags?.filter((t) => t[0] === tag).map((t) => t[1]) ?? [];
		// key starts with "#", so this is a tag filter: values are strings.
		if (!(vals as string[]).some((v) => present.includes(v))) return false;
	}
	return true;
}
