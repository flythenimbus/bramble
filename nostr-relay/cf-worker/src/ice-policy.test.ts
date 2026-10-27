import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	countRequest,
	GB,
	heavyCredentialsQuery,
	ipKey,
	monthTotalQuery,
	overCap,
	parseMonthTotal,
	policyFrom,
	summaryLine,
	turnAllowed,
	turnUsernames,
	type UsageState,
	withheldBy,
} from "./ice-policy.ts";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-12T20:30:00Z");
const policy = policyFrom({});

describe("policyFrom", () => {
	it("defaults to the free-tier ceiling with room to spare", () => {
		assert.equal(policy.monthlyCeilingBytes, 900 * GB);
		assert.equal(policy.credentialCapBytesPerHour, 10 * GB);
		assert.equal(policy.ttlSeconds, 7200);
		assert.equal(policy.requestsPerMinute, 20);
		assert.equal(policy.ticketlessPerMinute, 4);
		assert.equal(policy.requireTicket, false);
	});

	it("requires a ticket only when told to", () => {
		assert.equal(policyFrom({ ICE_REQUIRE_TICKET: "1" }).requireTicket, true);
		assert.equal(policyFrom({ ICE_REQUIRE_TICKET: "true" }).requireTicket, true);
		assert.equal(policyFrom({ ICE_REQUIRE_TICKET: "0" }).requireTicket, false);
	});

	it("takes the wrangler vars, and ignores ones that aren't positive numbers", () => {
		const p = policyFrom({ TURN_MONTHLY_CEILING_GB: "500", ICE_REQUESTS_PER_MINUTE: "nope" });
		assert.equal(p.monthlyCeilingBytes, 500 * GB);
		assert.equal(p.requestsPerMinute, 20);
		assert.equal(policyFrom({ TURN_TTL_SECONDS: "-1" }).ttlSeconds, 7200);
	});
});

describe("ipKey", () => {
	it("keeps an IPv4 address whole", () => {
		assert.equal(ipKey("203.0.113.7"), "203.0.113.7");
		assert.equal(ipKey("::ffff:203.0.113.7"), "203.0.113.7");
	});

	it("cuts IPv6 to the /64, so addresses inside it share one allowance", () => {
		assert.equal(ipKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd"), "2001:db8:1:2::/64");
		assert.equal(ipKey("2001:db8:1:2::9"), "2001:db8:1:2::/64");
		assert.equal(ipKey("2001:0DB8:0000:0002:0:0:0:1"), "2001:db8:0:2::/64");
		assert.equal(ipKey("2001:db8::1"), "2001:db8:0:0::/64");
		assert.equal(ipKey("::1"), "0:0:0:0::/64");
	});
});

describe("countRequest", () => {
	it("allows the limit in a minute, refuses the next, and starts over after it", () => {
		let window: ReturnType<typeof countRequest>["window"] | undefined;
		for (let i = 0; i < 20; i++) {
			const r = countRequest(window, NOW + i, 20);
			assert.equal(r.allowed, true);
			window = r.window;
		}
		assert.equal(countRequest(window, NOW + 30_000, 20).allowed, false);
		assert.deepEqual(countRequest(window, NOW + 60_000, 20), {
			window: { start: NOW + 60_000, count: 1 },
			allowed: true,
		});
	});
});

describe("turnAllowed", () => {
	const fresh = (egressBytes: number): UsageState => ({
		month: "2026-10",
		egressBytes,
		checkedAt: NOW - 600_000,
		since: NOW - 10 * HOUR,
	});

	it("hands out TURN under the ceiling and withholds it at it", () => {
		assert.equal(turnAllowed(fresh(899 * GB), policy, NOW, true), true);
		assert.equal(turnAllowed(fresh(900 * GB), policy, NOW, true), false);
	});

	it("has no ceiling while analytics is unconfigured, and before the first check", () => {
		assert.equal(turnAllowed(fresh(5000 * GB), policy, NOW, false), true);
		assert.equal(turnAllowed(undefined, policy, NOW, true), true);
	});

	it("withholds TURN once the total has gone an hour unconfirmed", () => {
		assert.equal(turnAllowed({ ...fresh(0), checkedAt: NOW - 2 * HOUR }, policy, NOW, true), false);
		// Checks that never once succeeded go stale from when they began.
		assert.equal(turnAllowed({ ...fresh(0), checkedAt: 0 }, policy, NOW, true), false);
		assert.equal(
			turnAllowed({ ...fresh(0), checkedAt: 0, since: NOW - 60_000 }, policy, NOW, true),
			true,
		);
	});

	it("starts each month afresh", () => {
		assert.equal(turnAllowed({ ...fresh(950 * GB), month: "2026-09" }, policy, NOW, true), true);
	});
});

describe("the analytics queries", () => {
	it("totals the month to date", () => {
		assert.deepEqual(monthTotalQuery("acct", NOW).variables, {
			accountTag: "acct",
			dateFrom: "2026-10-01",
			dateTo: "2026-10-12",
		});
	});

	it("reaches back across midnight for the last two hours", () => {
		const justAfter = Date.parse("2026-10-13T00:30:00Z");
		const { variables } = heavyCredentialsQuery("acct", justAfter);
		assert.equal(variables.dateFrom, "2026-10-12");
		assert.equal(variables.dateTo, "2026-10-13");
	});
});

const answer = (groups: unknown[]) => ({
	data: { viewer: { accounts: [{ callsTurnUsageAdaptiveGroups: groups }] } },
	errors: null,
});

describe("parseMonthTotal", () => {
	it("reads the sum, a month with no rows as zero, and an error as no answer", () => {
		assert.equal(parseMonthTotal(answer([{ sum: { egressBytes: 12345 } }])), 12345);
		assert.equal(parseMonthTotal(answer([])), 0);
		assert.equal(parseMonthTotal({ data: null, errors: [{ message: "no" }] }), null);
		assert.equal(parseMonthTotal(null), null);
	});
});

describe("overCap", () => {
	const row = (username: string, hoursAgo: number, gb: number) => ({
		dimensions: {
			username,
			datetimeHour: new Date(NOW - hoursAgo * HOUR - (NOW % HOUR)).toISOString(),
		},
		sum: { egressBytes: gb * GB },
	});

	it("names credentials over the cap in the last two hours, once, heaviest first", () => {
		const json = answer([
			row("heavy", 0, 40),
			row("heavy", 1, 30),
			row("also", 1, 11),
			row("old", 5, 50),
			row("light", 0, 2),
		]);
		assert.deepEqual(overCap(json, 10 * GB, NOW, 20), ["heavy", "also"]);
		assert.deepEqual(overCap(json, 10 * GB, NOW, 1), ["heavy"]);
		assert.equal(overCap({ errors: [{}] }, 10 * GB, NOW, 20), null);
	});
});

describe("turnUsernames", () => {
	it("takes the credential's username from Cloudflare's answer", () => {
		const minted = {
			iceServers: [
				{ urls: ["stun:stun.cloudflare.com:3478"] },
				{ urls: ["turn:turn.cloudflare.com:3478?transport=udp"], username: "u1", credential: "c" },
				{ urls: ["turns:turn.cloudflare.com:5349?transport=tcp"], username: "u1", credential: "c" },
			],
		};
		assert.deepEqual(turnUsernames(minted), ["u1"]);
		assert.deepEqual(turnUsernames({ iceServers: [] }), []);
		assert.deepEqual(turnUsernames(null), []);
	});
});

describe("withheldBy", () => {
	it("names the reason the month withholds TURN", () => {
		const state: UsageState = { month: "2026-10", egressBytes: 0, checkedAt: NOW, since: NOW };
		assert.equal(withheldBy(state, policy, NOW, true), null);
		assert.equal(withheldBy({ ...state, egressBytes: 900 * GB }, policy, NOW, true), "ceiling");
		assert.equal(
			withheldBy({ ...state, checkedAt: NOW - 2 * HOUR }, policy, NOW + HOUR, true),
			"stale",
		);
	});
});

describe("summaryLine", () => {
	it("counts TURN by ticket and STUN by reason, then the month against the ceiling", () => {
		assert.equal(
			summaryLine(
				{ "turn-ticketed": 38, "turn-ticketless": 3, "stun-rate": 2, "stun-ticket": 1 },
				10,
				8.11 * GB,
				900 * GB,
			),
			"[ice-guard] last 10 min: 41 TURN (38 ticketed), 3 STUN (rate 2, no ticket 1); month 8.1 of 900 GB",
		);
	});

	it("says so when nothing asked, or the month went unchecked", () => {
		assert.equal(
			summaryLine({}, 10, null, 900 * GB),
			"[ice-guard] last 10 min: no ICE requests; month not checked",
		);
	});
});
