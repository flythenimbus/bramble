// The one place TURN credentials are rationed: a single global Durable Object that every
// /ice-servers request asks first, and that a cron trigger asks to check usage. Requesters are
// known only by a salted hash of their address, rotated monthly; raw addresses are never stored.
// See docs/turn-credentials.md.

import { DurableObject } from "cloudflare:workers";
import {
	countRequest,
	heavyCredentialsQuery,
	type IceCounts,
	type IceOutcome,
	type IcePolicy,
	ipKey,
	monthOf,
	monthTotalQuery,
	overCap,
	parseMonthTotal,
	policyFrom,
	type RateWindow,
	summaryLine,
	type UsageState,
	withheldBy,
} from "./ice-policy";

export interface GuardEnv {
	TURN_KEY_TOKEN_ID?: string;
	TURN_KEY_API_TOKEN?: string;
	/** Account Analytics: Read, for the ceiling and the per-credential cap. */
	TURN_ANALYTICS_TOKEN?: string;
	CF_ACCOUNT_ID?: string;
	/** Private mode for a self-deployed Worker: sockets and ICE requests must carry ?token=. */
	RELAY_TOKEN?: string;
}

/** Revocations per check: bounds the subrequests one cron run makes. */
const MAX_REVOKES = 20;

interface Credential {
	requester: string;
	expiresAt: number;
}

export class IceGuard extends DurableObject<GuardEnv> {
	private policy(): IcePolicy {
		return policyFrom(this.env as unknown as Record<string, unknown>);
	}

	private analyticsConfigured(): boolean {
		return Boolean(this.env.TURN_ANALYTICS_TOKEN && this.env.CF_ACCOUNT_ID);
	}

	/** The requester's id: HMAC of its address under this month's salt. */
	private async requester(ip: string, now: number): Promise<string> {
		const month = monthOf(now);
		let salt = await this.ctx.storage.get<{ month: string; key: string }>("salt");
		if (salt?.month !== month) {
			const bytes = crypto.getRandomValues(new Uint8Array(32));
			salt = { month, key: btoa(String.fromCharCode(...bytes)) };
			await this.ctx.storage.put("salt", salt);
		}
		const raw = Uint8Array.from(atob(salt.key), (c) => c.charCodeAt(0));
		const key = await crypto.subtle.importKey(
			"raw",
			raw,
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"],
		);
		const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(ipKey(ip)));
		return [...new Uint8Array(mac).slice(0, 16)]
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
	}

	/**
	 * "turn" to mint, or why it's STUN only, which is counted here. A TURN answer is counted by
	 * record, once a credential exists. `ticketed`: the request named a live socket on this relay.
	 */
	async admit(ip: string, ticketed: boolean): Promise<"turn" | IceOutcome> {
		const verdict = await this.verdict(ip, ticketed);
		if (verdict !== "turn") await this.count(verdict);
		return verdict;
	}

	private async verdict(ip: string, ticketed: boolean): Promise<"turn" | IceOutcome> {
		const now = Date.now();
		const policy = this.policy();
		if (!ticketed && policy.requireTicket) return "stun-ticket";
		const who = await this.requester(ip, now);
		const blockedUntil = await this.ctx.storage.get<number>(`block:${who}`);
		if (blockedUntil && blockedUntil > now) return "stun-blocked";
		const { window, allowed } = countRequest(
			await this.ctx.storage.get<RateWindow>(`rate:${who}`),
			now,
			ticketed ? policy.requestsPerMinute : policy.ticketlessPerMinute,
		);
		await this.ctx.storage.put(`rate:${who}`, window);
		if (!allowed) return "stun-rate";
		const usage = await this.ctx.storage.get<UsageState>("usage");
		const withheld = withheldBy(usage, policy, now, this.analyticsConfigured());
		return withheld ? `stun-${withheld}` : "turn";
	}

	/** Tie freshly minted credentials to their requester, for the per-credential cap. */
	async record(
		ip: string,
		usernames: string[],
		expiresAt: number,
		ticketed: boolean,
	): Promise<void> {
		const requester = await this.requester(ip, Date.now());
		for (const username of usernames) {
			await this.ctx.storage.put(`cred:${username}`, { requester, expiresAt } satisfies Credential);
		}
		await this.count(ticketed ? "turn-ticketed" : "turn-ticketless");
	}

	/** One more answer of this kind, for the next summary. */
	async count(outcome: IceOutcome): Promise<void> {
		const counts = (await this.ctx.storage.get<IceCounts>("counts")) ?? {};
		counts[outcome] = (counts[outcome] ?? 0) + 1;
		await this.ctx.storage.put("counts", counts);
	}

	/** Log how requests were answered since the last summary, and the month so far; then reset. */
	private async summarize(now: number, monthBytes: number | null): Promise<void> {
		const counts = (await this.ctx.storage.get<IceCounts>("counts")) ?? {};
		const since = (await this.ctx.storage.get<number>("countsSince")) ?? now;
		const minutes = Math.max(1, Math.round((now - since) / 60_000));
		console.log(summaryLine(counts, minutes, monthBytes, this.policy().monthlyCeilingBytes));
		await this.ctx.storage.put({ counts: {}, countsSince: now });
	}

	/** The cron's work: refresh the month total, revoke credentials over the cap, prune. */
	async enforce(): Promise<void> {
		const now = Date.now();
		const policy = this.policy();
		await this.prune(now);
		const { CF_ACCOUNT_ID: account, TURN_ANALYTICS_TOKEN: token } = this.env;
		if (!account || !token) {
			console.warn(
				"[ice-guard] TURN_ANALYTICS_TOKEN or CF_ACCOUNT_ID unset: no monthly ceiling, no per-credential cap",
			);
			await this.summarize(now, null);
			return;
		}

		const previous = await this.ctx.storage.get<UsageState>("usage");
		const total = parseMonthTotal(await this.graphql(token, monthTotalQuery(account, now)));
		const usage: UsageState =
			total === null
				? (previous ?? { month: monthOf(now), egressBytes: 0, checkedAt: 0, since: now })
				: {
						month: monthOf(now),
						egressBytes: total,
						checkedAt: now,
						since: previous?.since ?? now,
					};
		await this.ctx.storage.put("usage", usage);
		if (total === null) console.error("[ice-guard] monthly TURN usage check failed");
		await this.summarize(now, total);

		const heavy = overCap(
			await this.graphql(token, heavyCredentialsQuery(account, now)),
			policy.credentialCapBytesPerHour,
			now,
			MAX_REVOKES,
		);
		if (heavy === null) {
			console.error("[ice-guard] per-credential TURN usage check failed");
			return;
		}
		for (const username of heavy) {
			const cred = await this.ctx.storage.get<Credential>(`cred:${username}`);
			if (cred) await this.ctx.storage.put(`block:${cred.requester}`, now + policy.blockMs);
			await this.revoke(username);
			await this.ctx.storage.delete(`cred:${username}`);
			console.warn(`[ice-guard] revoked a TURN credential over the hourly cap`);
		}
	}

	private async graphql(token: string, body: unknown): Promise<unknown> {
		try {
			const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
				method: "POST",
				headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			return res.ok ? await res.json() : null;
		} catch {
			return null;
		}
	}

	private async revoke(username: string): Promise<void> {
		const { TURN_KEY_TOKEN_ID: id, TURN_KEY_API_TOKEN: token } = this.env;
		if (!id || !token) return;
		const url = `https://rtc.live.cloudflare.com/v1/turn/keys/${id}/credentials/${encodeURIComponent(username)}/revoke`;
		const res = await fetch(url, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}` },
		}).catch(() => null);
		if (!res?.ok)
			console.error(`[ice-guard] revoking a credential failed: ${res?.status ?? "network"}`);
	}

	/** Drop expired credentials, blocks and rate windows. */
	private async prune(now: number): Promise<void> {
		const stale: string[] = [];
		for (const [key, cred] of await this.ctx.storage.list<Credential>({ prefix: "cred:" })) {
			if (cred.expiresAt <= now) stale.push(key);
		}
		for (const [key, until] of await this.ctx.storage.list<number>({ prefix: "block:" })) {
			if (until <= now) stale.push(key);
		}
		for (const [key, window] of await this.ctx.storage.list<RateWindow>({ prefix: "rate:" })) {
			if (now - window.start > 2 * 60_000) stale.push(key);
		}
		// delete() takes at most 128 keys at a time.
		for (let i = 0; i < stale.length; i += 128)
			await this.ctx.storage.delete(stale.slice(i, i + 128));
	}
}
