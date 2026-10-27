// Who gets Cloudflare TURN credentials, and how much they may use. Pure, so `node --test` covers
// it without the Workers runtime; ice-guard.ts applies it. See docs/turn-credentials.md.

export const GB = 1_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A ticket vouches for a socket that has published this recently; clients say hello every 30 s. */
export const TICKET_ACTIVE_MS = 5 * MINUTE;

export interface IcePolicy {
	ttlSeconds: number;
	/** For a request whose ticket names a live socket on this relay. */
	requestsPerMinute: number;
	/** For one without: released apps send none, and neither does a device on another relay. */
	ticketlessPerMinute: number;
	/** Once on, a request without a live ticket gets STUN only. */
	requireTicket: boolean;
	/** Past this much egress in a calendar month (UTC), only STUN is handed out. */
	monthlyCeilingBytes: number;
	/** One credential using more than this in a clock hour is revoked, and its requester blocked. */
	credentialCapBytesPerHour: number;
	blockMs: number;
	/** A month total older than this no longer vouches for TURN: withheld until a check succeeds. */
	staleAfterMs: number;
}

type Vars = Record<string, unknown>;

function positive(vars: Vars, key: string, fallback: number): number {
	const n = Number(vars[key]);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function policyFrom(vars: Vars): IcePolicy {
	return {
		ttlSeconds: Math.floor(positive(vars, "TURN_TTL_SECONDS", 7200)),
		requestsPerMinute: Math.floor(positive(vars, "ICE_REQUESTS_PER_MINUTE", 20)),
		ticketlessPerMinute: Math.floor(positive(vars, "ICE_TICKETLESS_PER_MINUTE", 4)),
		requireTicket: vars.ICE_REQUIRE_TICKET === "1" || vars.ICE_REQUIRE_TICKET === "true",
		monthlyCeilingBytes: positive(vars, "TURN_MONTHLY_CEILING_GB", 900) * GB,
		credentialCapBytesPerHour: positive(vars, "TURN_CREDENTIAL_CAP_GB_PER_HOUR", 10) * GB,
		blockMs: 24 * HOUR,
		staleAfterMs: HOUR,
	};
}

/** What clients get when TURN is withheld: Cloudflare's STUN is free and unmetered, so a device
 * can still punch through NAT. An empty list would cost it that too (clients read a non-200 as []). */
export const STUN_ONLY = {
	iceServers: [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"] }],
};

/**
 * The address a limit applies to. IPv6 is cut to its /64, the block one subscriber is given, so
 * stepping through addresses inside it doesn't buy a fresh allowance.
 */
export function ipKey(ip: string): string {
	if (!ip.includes(":")) return ip;
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
	if (mapped?.[1]) return mapped[1];
	const [head = "", tail = ""] = ip.toLowerCase().split("::");
	const left = head ? head.split(":") : [];
	const right = tail ? tail.split(":") : [];
	const missing = ip.includes("::") ? 8 - left.length - right.length : 0;
	const groups = [...left, ...Array(Math.max(missing, 0)).fill("0"), ...right];
	return `${groups
		.slice(0, 4)
		.map((g) => g.replace(/^0+(?=.)/, ""))
		.join(":")}::/64`;
}

export interface RateWindow {
	start: number;
	count: number;
}

/** A fixed one-minute window per requester. */
export function countRequest(
	prev: RateWindow | undefined,
	now: number,
	limit: number,
): { window: RateWindow; allowed: boolean } {
	const window =
		prev && now - prev.start < MINUTE
			? { start: prev.start, count: prev.count + 1 }
			: { start: now, count: 1 };
	return { window, allowed: window.count <= limit };
}

export interface UsageState {
	/** "2026-10": the month `egressBytes` is for. */
	month: string;
	egressBytes: number;
	/** The last successful check, or 0 before the first. */
	checkedAt: number;
	/** When checks began, so a guard that never gets an answer still goes stale. */
	since: number;
}

export function monthOf(now: number): string {
	return new Date(now).toISOString().slice(0, 7);
}

/**
 * Whether TURN may be handed out. Unconfigured analytics means no ceiling (logged on every check);
 * once configured, a month total that has gone unconfirmed for `staleAfterMs` withholds TURN rather
 * than letting a broken check run up a bill.
 */
export function turnAllowed(
	state: UsageState | undefined,
	policy: IcePolicy,
	now: number,
	analyticsConfigured: boolean,
): boolean {
	return withheldBy(state, policy, now, analyticsConfigured) === null;
}

/** Why the month's usage withholds TURN, or null when it doesn't. See turnAllowed. */
export function withheldBy(
	state: UsageState | undefined,
	policy: IcePolicy,
	now: number,
	analyticsConfigured: boolean,
): "ceiling" | "stale" | null {
	if (!analyticsConfigured || !state) return null;
	if (now - (state.checkedAt || state.since) > policy.staleAfterMs) return "stale";
	if (state.month !== monthOf(now)) return null;
	return state.egressBytes < policy.monthlyCeilingBytes ? null : "ceiling";
}

/** How the guard answered an ICE request. TURN counts once a credential was actually minted. */
export type IceOutcome =
	| "turn-ticketed"
	| "turn-ticketless"
	| "stun-rate"
	| "stun-blocked"
	| "stun-ceiling"
	| "stun-stale"
	| "stun-ticket"
	| "stun-mint-failed";

export type IceCounts = Partial<Record<IceOutcome, number>>;

const STUN_LABELS: [IceOutcome, string][] = [
	["stun-rate", "rate"],
	["stun-blocked", "blocked"],
	["stun-ceiling", "ceiling"],
	["stun-stale", "stale total"],
	["stun-ticket", "no ticket"],
	["stun-mint-failed", "mint failed"],
];

/**
 * The cron's one line: how requests were answered since the last run, and the month so far, so a
 * deploy can be checked against the dashboard and the ticketed share says when to require tickets.
 */
export function summaryLine(
	counts: IceCounts,
	minutes: number,
	monthBytes: number | null,
	ceilingBytes: number,
): string {
	const ticketed = counts["turn-ticketed"] ?? 0;
	const turn = ticketed + (counts["turn-ticketless"] ?? 0);
	const reasons = STUN_LABELS.filter(([k]) => counts[k]).map(
		([k, label]) => `${label} ${counts[k]}`,
	);
	const stun = STUN_LABELS.reduce((n, [k]) => n + (counts[k] ?? 0), 0);
	const answers =
		turn + stun === 0
			? "no ICE requests"
			: `${turn} TURN (${ticketed} ticketed), ${stun} STUN${reasons.length ? ` (${reasons.join(", ")})` : ""}`;
	const month =
		monthBytes === null
			? "month not checked"
			: `month ${(monthBytes / GB).toFixed(1)} of ${Math.round(ceilingBytes / GB)} GB`;
	return `[ice-guard] last ${minutes} min: ${answers}; ${month}`;
}

export interface GraphqlRequest {
	query: string;
	variables: Record<string, string>;
}

const day = (t: number) => new Date(t).toISOString().slice(0, 10);

/** This month's TURN egress across the account: the free tier is per account, not per key. */
export function monthTotalQuery(accountTag: string, now: number): GraphqlRequest {
	return {
		query: `query monthTotal($accountTag: string!, $dateFrom: Date!, $dateTo: Date!) {
	viewer {
		accounts(filter: { accountTag: $accountTag }) {
			callsTurnUsageAdaptiveGroups(limit: 1, filter: { date_geq: $dateFrom, date_leq: $dateTo }) {
				sum { egressBytes }
			}
		}
	}
}`,
		variables: { accountTag, dateFrom: `${monthOf(now)}-01`, dateTo: day(now) },
	};
}

/** The heaviest (credential, hour) pairs since two hours ago, the longest a credential lives. */
export function heavyCredentialsQuery(accountTag: string, now: number): GraphqlRequest {
	return {
		query: `query heavyCredentials($accountTag: string!, $dateFrom: Date!, $dateTo: Date!) {
	viewer {
		accounts(filter: { accountTag: $accountTag }) {
			callsTurnUsageAdaptiveGroups(
				limit: 100
				filter: { date_geq: $dateFrom, date_leq: $dateTo }
				orderBy: [sum_egressBytes_DESC]
			) {
				dimensions { username datetimeHour }
				sum { egressBytes }
			}
		}
	}
}`,
		variables: { accountTag, dateFrom: day(now - 2 * HOUR), dateTo: day(now) },
	};
}

type Row = {
	dimensions?: { username?: unknown; datetimeHour?: unknown };
	sum?: { egressBytes?: unknown };
};

function rows(json: unknown): Row[] | null {
	const body = json as {
		errors?: unknown[] | null;
		data?: { viewer?: { accounts?: { callsTurnUsageAdaptiveGroups?: Row[] }[] } };
	} | null;
	if (!body || (Array.isArray(body.errors) && body.errors.length > 0)) return null;
	const groups = body.data?.viewer?.accounts?.[0]?.callsTurnUsageAdaptiveGroups;
	return Array.isArray(groups) ? groups : null;
}

/** The month's egress in bytes, or null when the answer isn't one. No rows is a month with none. */
export function parseMonthTotal(json: unknown): number | null {
	const groups = rows(json);
	if (!groups) return null;
	const bytes = Number(groups[0]?.sum?.egressBytes ?? 0);
	return Number.isFinite(bytes) ? bytes : null;
}

/** Credentials over the hourly cap in either of the last two clock hours, heaviest first. */
export function overCap(
	json: unknown,
	capBytes: number,
	now: number,
	max: number,
): string[] | null {
	const groups = rows(json);
	if (!groups) return null;
	const out: string[] = [];
	for (const row of groups) {
		const username = row.dimensions?.username;
		const hour = Date.parse(String(row.dimensions?.datetimeHour ?? ""));
		const bytes = Number(row.sum?.egressBytes ?? 0);
		if (typeof username !== "string" || !username || !(bytes > capBytes)) continue;
		if (!(now - hour < 2 * HOUR)) continue;
		if (!out.includes(username)) out.push(username);
		if (out.length >= max) break;
	}
	return out;
}

/** The TURN usernames in a generate-ice-servers answer, to tie each to its requester. */
export function turnUsernames(body: unknown): string[] {
	const list = (body as { iceServers?: unknown } | null)?.iceServers;
	const servers = Array.isArray(list) ? list : list ? [list] : [];
	const names = servers
		.map((s) => (s as { username?: unknown }).username)
		.filter((u): u is string => typeof u === "string" && u.length > 0);
	return [...new Set(names)];
}
